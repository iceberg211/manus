/**
 * Human-in-the-Loop Node — Pauses execution for human input.
 *
 * Translated from: app/tool/ask_human.py (22 lines)
 *
 * OpenManus used AskHuman as a tool with blocking input().
 * LangGraph uses interrupt() to pause the graph non-blockingly.
 *
 * How it works:
 * 1. After "think" node, routing checks if LLM called "ask_human"
 * 2. If yes → routes to "human_review" node
 * 3. human_review calls interrupt() with the question
 * 4. Graph pauses — caller sees __interrupt__ with the question
 * 5. Caller resumes with Command({ resume: "user's answer" })
 * 6. interrupt() returns the answer
 * 7. Node returns ToolMessage with the answer → back to "think"
 *
 * Requirements: checkpointer + thread_id (see persistence skill)
 *
 * IMPORTANT: Code before interrupt() re-runs on resume.
 * We keep this node minimal — no side effects before interrupt().
 */
import { ToolMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import type { AgentStateType } from "@/state/agentState";

/**
 * Check if the last AI message contains an ask_human tool call.
 * Used as a routing function after "think".
 */
export function hasHumanRequest(state: AgentStateType): boolean {
  const lastMsg = state.messages[state.messages.length - 1];
  if (!lastMsg || lastMsg._getType() !== "ai") return false;
  const toolCalls = (lastMsg as any).tool_calls ?? [];
  return toolCalls.some((tc: any) => tc.name === "ask_human");
}

/**
 * Human review node — pauses with interrupt(), resumes with user's answer.
 *
 * Matches AskHuman.execute() behavior:
 *   Python: return input(f"Bot: {inquire}\n\nYou: ").strip()
 *   TS: answer = interrupt({ question }) → return ToolMessage
 */
export function humanReviewNode(state: AgentStateType) {
  const lastMsg = state.messages[state.messages.length - 1];
  const toolCalls = (lastMsg as any).tool_calls ?? [];

  const askCall = toolCalls.find((tc: any) => tc.name === "ask_human");
  if (!askCall) {
    // Shouldn't reach here, but handle gracefully
    return {};
  }

  const question = askCall.args?.inquire ?? askCall.args?.question ?? "What would you like to do?";

  // interrupt() pauses the graph here.
  // When resumed with Command({ resume: "answer" }), this returns "answer".
  // NOTE: Everything above this line re-runs on resume (idempotent: just reads state).
  const humanAnswer = interrupt({
    question,
    tool_call_id: askCall.id,
    context: "The agent needs your input to proceed.",
  });

  // After resume: wrap the human's answer as a ToolMessage
  // so the LLM sees it as the result of the ask_human tool call.
  return {
    messages: [
      new ToolMessage({
        content: typeof humanAnswer === "string" ? humanAnswer : JSON.stringify(humanAnswer),
        tool_call_id: askCall.id,
        name: "ask_human",
      }),
    ],
  };
}
