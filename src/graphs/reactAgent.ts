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
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, trimMessages, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { RunnableLambda, type RunnableConfig } from "@langchain/core/runnables";

import { AgentState, type AgentStateType } from "@/state/agentState";
import { createThinkNode } from "@/nodes/think";
import { checkStuck, injectUnstuck } from "@/nodes/checkStuck";
import { hasHumanRequest, humanReviewNode } from "@/nodes/humanReview";
import { prepareContextNode } from "@/nodes/prepareContext";
import { terminate } from "@/tools/terminate";
import { askHuman } from "@/tools/askHuman";

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
 * 1. Trim history to fit within maxInputTokens (A-1)
 * 2. Prepend systemPrompt (if provided)
 * 3. Append nextStepPrompt as HumanMessage (if provided)
 * 4. Adapt AIMessages for non-OpenAI provider compatibility
 *
 * Returns a Runnable<BaseMessage[], AIMessage> — same interface as the model,
 * so the think node just calls model.invoke(state.messages).
 *
 * A-1: 长对话 token 截断。`trimMessages` 使用 strategy="last" 保留最近的消息，
 * `startOn: "human"` 确保结果从一轮对话边界开始（避免单独的 AIMessage 开头造成
 * provider 错误），`includeSystem: true` 保留 system prompt。未配置时不截断。
 */
function wrapModelWithMiddleware(
  model: any,
  opts: {
    systemPrompt?: string;
    nextStepPrompt?: string;
    maxInputTokens?: number;
  },
) {
  const { systemPrompt, nextStepPrompt, maxInputTokens } = opts;

  // token 预估：如果 model.getNumTokens 不存在就用简单字符数估算。
  async function countTokens(msgs: BaseMessage[]): Promise<number> {
    if (typeof (model as any).getNumTokens === "function") {
      try {
        const text = msgs.map((m) =>
          typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        ).join("\n");
        return await (model as any).getNumTokens(text);
      } catch {
        /* fall through */
      }
    }
    // Fallback: ~4 chars per token
    const total = msgs.reduce((sum, m) => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return sum + c.length;
    }, 0);
    return Math.ceil(total / 4);
  }

  const preprocessor = RunnableLambda.from(async (messages: BaseMessage[]) => {
    let history = messages;

    if (maxInputTokens && maxInputTokens > 0) {
      try {
        history = await trimMessages(messages, {
          maxTokens: maxInputTokens,
          strategy: "last",
          tokenCounter: countTokens,
          startOn: "human",
          includeSystem: true,
          allowPartial: false,
        });
      } catch {
        // trimMessages 对消息结构敏感（比如 orphan tool_call 会报错），
        // 失败时退回原始消息，由 think 节点的 token-limit catch 兜底。
        history = messages;
      }
    }

    const prepared: BaseMessage[] = [];
    if (systemPrompt) prepared.push(new SystemMessage(systemPrompt));
    prepared.push(...history);
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

/**
 * After "tools": check stuck state, then route to the entry node (either
 * "think" directly or "prepare_context" → "think" when browser context is enabled).
 */
function makeAfterTools(entryNode: "think" | "prepare_context") {
  return (state: AgentStateType): "inject_unstuck" | "think" | "prepare_context" => {
    if (state.status === "finished") return entryNode;
    const stuck = checkStuck(state);
    return stuck === "think" ? entryNode : "inject_unstuck";
  };
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
  /**
   * Enable checkpointer for persistence/HITL.
   *
   * - `false` (default): no checkpointer, no HITL support
   * - `true`: use in-memory MemorySaver (dev only, lost on restart)
   * - a `BaseCheckpointSaver` instance: production checkpointer (e.g. PostgresSaver)
   *
   * HITL (interrupt/resume) requires a checkpointer. Callers that need HITL
   * MUST set this explicitly. We no longer auto-enable it when
   * `enableHumanInTheLoop` is true, because every invocation with a new
   * thread_id accumulates checkpoints in MemorySaver and leaks memory.
   */
  checkpointer?: boolean | BaseCheckpointSaver;
  /** Include ask_human tool. Default: true. */
  enableHumanInTheLoop?: boolean;
  /**
   * A-6: 在 think 前注入浏览器上下文（URL、title、interactive elements、截图）。
   * 仅当工具列表包含 browser_use 时建议开启。
   * 节点内部会检测最近消息中是否使用过 browser_use — 未用时跳过注入。
   */
  browserContextEnabled?: boolean;
  /**
   * A-1: 最大输入 token 数。超过时会用 trimMessages 从末尾保留最近的消息。
   * 未设置（或为 0）时不截断，长任务可能触发 token limit。
   * 建议 < model context window - maxTokens reservation。
   */
  maxInputTokens?: number;
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
    browserContextEnabled = false,
    maxInputTokens,
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
    maxInputTokens,
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

  // Build graph — RetryPolicy on think for transient LLM errors.
  // When browserContextEnabled=true, insert a `prepare_context` node before
  // every entry into `think`, so the LLM sees the latest browser DOM state
  // and screenshot. The node itself is a no-op when browser_use wasn't used
  // recently, so the overhead is minimal.
  const entryNode: "think" | "prepare_context" = browserContextEnabled
    ? "prepare_context"
    : "think";
  const afterTools = makeAfterTools(entryNode);

  let builder: any = new StateGraph(AgentState)
    .addNode("think", thinkNode, {
      retryPolicy: { maxAttempts: 3 },
    })
    .addNode("tools", truncatedToolNode)
    .addNode("inject_unstuck", injectUnstuck)
    .addNode("human_review", humanReviewNode);

  if (browserContextEnabled) {
    builder = builder.addNode("prepare_context", prepareContextNode);
  }

  builder = builder
    // START → entry (prepare_context or think)
    .addEdge(START, entryNode)
    // think → human_review / tools / END
    .addConditionalEdges("think", shouldContinue, [
      "human_review",
      "tools",
      END,
    ])
    // human_review → entry (after user responds via Command(resume=...))
    .addEdge("human_review", entryNode)
    // tools → check stuck → entry or inject_unstuck
    .addConditionalEdges("tools", afterTools, [entryNode, "inject_unstuck"])
    // inject_unstuck → entry
    .addEdge("inject_unstuck", entryNode);

  if (browserContextEnabled) {
    builder = builder.addEdge("prepare_context", "think");
  }

  const graph = builder;

  // Compile — checkpointer required for HITL interrupt().
  // NOTE: recursionLimit is NOT a compile() option in LangGraph TS 0.2.x.
  // It must be passed via invoke/stream config (see wrapper below).
  const compileOptions: {
    checkpointer?: BaseCheckpointSaver;
  } = {};
  if (useCheckpointer === true) {
    compileOptions.checkpointer = new MemorySaver();
  } else if (useCheckpointer && typeof useCheckpointer === "object") {
    compileOptions.checkpointer = useCheckpointer;
  }

  const compiled = graph.compile(compileOptions);

  // Wrap invoke/stream via Proxy to inject recursionLimit without mutating the
  // compiled graph (which would clobber own properties and confuse prototypes).
  // For non-wrapped methods (getState, updateState, etc.) we bind `this` to the
  // target so prototype-resolved methods still see the original receiver.
  return new Proxy(compiled, {
    get(target, prop) {
      if (prop === "invoke") {
        return (input: any, config?: RunnableConfig) =>
          target.invoke(input, { recursionLimit, ...config });
      }
      if (prop === "stream") {
        return (input: any, config?: any) =>
          target.stream(input, { recursionLimit, ...config });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
