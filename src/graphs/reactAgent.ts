/**
 * ReAct Agent Graph — Core think→act loop with HITL support.
 *
 * Translated from:
 *   - app/agent/base.py    BaseAgent.run() — the execution loop
 *   - app/agent/react.py   ReActAgent.step() = think() + act()
 *   - app/agent/toolcall.py ToolCallAgent — tool calling logic
 *   - app/tool/ask_human.py AskHuman — now implemented via interrupt()
 *
 * Graph structure:
 *
 *   START → think ──ask_human?──→ human_review (interrupt) ──→ think
 *                  │
 *                  ├─has_tools?──→ tools ──stuck?──→ think (loop)
 *                  │                       │ stuck
 *                  │                       ↓
 *                  │                  inject_unstuck → think
 *                  │
 *                  └─no tools/terminate──→ END
 */
import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { RunnableLambda, type RunnableConfig } from "@langchain/core/runnables";

import { AgentState, type AgentStateType } from "../state/agentState.js";
import { createThinkNode } from "../nodes/think.js";
import { checkStuck, injectUnstuck } from "../nodes/checkStuck.js";
import { hasHumanRequest, humanReviewNode } from "../nodes/humanReview.js";
import { terminate } from "../tools/terminate.js";
import { askHuman } from "../tools/askHuman.js";

// ---------------------------------------------------------------------------
// Model middleware — prompt injection + provider compatibility
// ---------------------------------------------------------------------------

/**
 * Adapt messages for providers that reject content:null (Qwen, DeepSeek, etc.).
 *
 * Root cause: @langchain/openai's _convertMessagesToOpenAIParams hardcodes
 * `content = null` for AIMessages with tool_calls. OpenAI accepts this, but
 * many OpenAI-compatible providers require content to always be a string.
 *
 * Fix: For AIMessages with tool_calls, create a copy where tool_calls is
 * moved to additional_kwargs (the serializer's else branch preserves content).
 */
function adaptMessagesForProvider(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((msg) => {
    if (msg._getType() !== "ai") return msg;
    const aiMsg = msg as AIMessage;
    if (!aiMsg.tool_calls?.length) return msg;

    const openAIToolCalls = aiMsg.tool_calls.map((tc) => ({
      id: tc.id ?? "",
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args),
      },
    }));

    return new AIMessage({
      content: aiMsg.content ?? "",
      tool_calls: [],
      additional_kwargs: { ...aiMsg.additional_kwargs, tool_calls: openAIToolCalls },
      response_metadata: aiMsg.response_metadata,
      id: aiMsg.id,
    });
  });
}

/**
 * Wrap a model with message middleware:
 * 1. Prepend systemPrompt (if provided)
 * 2. Append nextStepPrompt as HumanMessage (if provided)
 * 3. Adapt AIMessages for non-OpenAI provider compatibility
 *
 * Returns a Runnable<BaseMessage[], AIMessage> — same interface as the model,
 * so the think node just calls model.invoke(state.messages).
 */
function wrapModelWithMiddleware(
  model: any,
  opts: { systemPrompt?: string; nextStepPrompt?: string },
) {
  const { systemPrompt, nextStepPrompt } = opts;

  const preprocessor = RunnableLambda.from((messages: BaseMessage[]) => {
    const prepared: BaseMessage[] = [];
    if (systemPrompt) prepared.push(new SystemMessage(systemPrompt));
    prepared.push(...messages);
    if (nextStepPrompt) prepared.push(new HumanMessage(nextStepPrompt));
    return adaptMessagesForProvider(prepared);
  });

  return preprocessor.pipe(model);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * After "think": route to human_review, tools, or END.
 *
 * Priority: ask_human > terminate > other tools > no tools (END)
 */
function shouldContinue(
  state: AgentStateType,
): "human_review" | "tools" | "__end__" {
  if (state.status === "finished") return END;

  const lastMsg = state.messages[state.messages.length - 1];
  if (!lastMsg) return END;

  const toolCalls =
    "tool_calls" in lastMsg ? (lastMsg as any).tool_calls : undefined;

  if (!toolCalls || toolCalls.length === 0) return END;

  // ask_human takes priority — pause for human input
  if (hasHumanRequest(state)) return "human_review";

  // Terminate → end
  if (toolCalls.some((tc: any) => tc.name?.toLowerCase() === "terminate")) {
    return END;
  }

  return "tools";
}

/** After "tools": check stuck state, then back to think. */
function afterTools(state: AgentStateType): "inject_unstuck" | "think" {
  if (state.status === "finished") return "think";
  return checkStuck(state);
}

// ---------------------------------------------------------------------------
// Graph builder factory
// ---------------------------------------------------------------------------

export interface ReactAgentOptions {
  /** LLM model instance. Must support .bindTools(). Any LangChain ChatModel works.
   * Use createLLM() from config/llmFactory.ts to create. */
  model: BaseChatModel;
  /** Tools available to the agent. terminate + ask_human always included. */
  tools?: StructuredToolInterface[];
  /** System prompt. */
  systemPrompt?: string;
  /** Next-step prompt injected each turn. */
  nextStepPrompt?: string;
  /** Max tool output length (chars). Default: 10000. */
  maxObserve?: number;
  /** Max graph iterations. Default: 50. */
  recursionLimit?: number;
  /** Enable checkpointer for persistence/HITL. */
  checkpointer?: boolean;
  /** Include ask_human tool. Default: true. */
  enableHumanInTheLoop?: boolean;
}

/**
 * Build a ReAct agent graph.
 *
 * This is the core factory that replaces the entire ToolCallAgent class hierarchy.
 * Different agent types (Manus, SWE, Browser, etc.) are created by passing
 * different tools and prompts.
 *
 * Returns the compiled graph. The graph's invoke/stream methods automatically
 * inject recursionLimit into config so callers don't need to remember.
 */
export function buildReactAgent(options: ReactAgentOptions) {
  const {
    model,
    tools = [],
    systemPrompt,
    nextStepPrompt,
    maxObserve = 10000,
    recursionLimit = 50,
    checkpointer: useCheckpointer = false,
    enableHumanInTheLoop = true,
  } = options;

  // Build tool list
  const allTools: StructuredToolInterface[] = [...tools];
  if (!allTools.some((t) => t.name === "terminate")) {
    allTools.push(terminate);
  }
  if (enableHumanInTheLoop && !allTools.some((t) => t.name === "ask_human")) {
    allTools.push(askHuman);
  }

  // Bind tools to model.
  // Disable parallel_tool_calls when ask_human is present — if the LLM returns
  // ask_human + another tool in parallel, human_review only returns a ToolMessage
  // for ask_human, leaving the other tool_calls orphaned (next LLM call would fail).
  const bindOpts: Record<string, any> = {};
  if (enableHumanInTheLoop) {
    bindOpts.parallel_tool_calls = false;
  }
  const modelWithTools = (model as any).bindTools(allTools, bindOpts);

  // Wrap model with middleware: prompt injection + provider compat adapter.
  // The think node just calls wrappedModel.invoke(state.messages) — no message
  // manipulation in the node itself.
  const wrappedModel = wrapModelWithMiddleware(modelWithTools, {
    systemPrompt,
    nextStepPrompt,
  });

  // Create nodes
  const thinkNode = createThinkNode(wrappedModel);

  // ToolNode — filter out ask_human since it's handled by humanReview node
  const executableTools = allTools.filter((t) => t.name !== "ask_human");
  const toolNode = new ToolNode(executableTools, { handleToolErrors: true });

  // Wrap tool node for max_observe truncation.
  // Creates new ToolMessage objects instead of mutating (protects checkpoint refs).
  const truncatedToolNode = async (state: AgentStateType) => {
    const result = await toolNode.invoke(state);

    if (maxObserve && result.messages) {
      result.messages = result.messages.map((msg: any) => {
        if (
          typeof msg.content === "string" &&
          msg.content.length > maxObserve
        ) {
          return new ToolMessage({
            content: msg.content.slice(0, maxObserve) + "\n... (truncated)",
            tool_call_id: msg.tool_call_id,
            name: msg.name,
          });
        }
        return msg;
      });
    }

    return result;
  };

  // Build graph — RetryPolicy on think for transient LLM errors
  const graph = new StateGraph(AgentState)
    .addNode("think", thinkNode, {
      retryPolicy: { maxAttempts: 3 },
    })
    .addNode("tools", truncatedToolNode)
    .addNode("inject_unstuck", injectUnstuck)
    .addNode("human_review", humanReviewNode)
    // START → think
    .addEdge(START, "think")
    // think → human_review / tools / END
    .addConditionalEdges("think", shouldContinue, [
      "human_review",
      "tools",
      END,
    ])
    // human_review → think (after user responds via Command(resume=...))
    .addEdge("human_review", "think")
    // tools → check stuck → think or inject_unstuck
    .addConditionalEdges("tools", afterTools, ["think", "inject_unstuck"])
    // inject_unstuck → think
    .addEdge("inject_unstuck", "think");

  // Compile — checkpointer required for HITL interrupt()
  // NOTE: recursionLimit is NOT a compile() option in LangGraph TS 0.2.x.
  // It must be passed via invoke/stream config (see wrapper below).
  const needsCheckpointer = useCheckpointer || enableHumanInTheLoop;
  const compileOptions: {
    checkpointer?: MemorySaver;
  } = {};
  if (needsCheckpointer) {
    compileOptions.checkpointer = new MemorySaver();
  }

  const compiled = graph.compile(compileOptions);

  // Wrap invoke/stream to automatically inject recursionLimit into config.
  // This ensures the limit is always applied without requiring every caller to remember.
  const origInvoke = compiled.invoke.bind(compiled);
  const origStream = compiled.stream.bind(compiled);

  compiled.invoke = (input: any, config?: RunnableConfig) => {
    return origInvoke(input, { recursionLimit, ...config });
  };
  compiled.stream = (input: any, config?: any) => {
    return origStream(input, { recursionLimit, ...config });
  };

  return compiled;
}
