/**
 * Think Node — LLM reasoning step.
 *
 * Translated from: app/agent/toolcall.py ToolCallAgent.think() (lines 39-129)
 *
 * The node itself is minimal: model.invoke(state.messages) → return AIMessage.
 * All message preprocessing (system prompt, next-step prompt, provider compat)
 * is handled by the model middleware pipeline built in reactAgent.ts.
 *
 * Stuck detection is handled by a separate checkStuck node.
 */
import { AIMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import type { AgentStateType } from "../state/agentState.js";

/**
 * Create a think node. The model should already have middleware applied
 * (prompt injection, provider adaptation) via wrapModelWithMiddleware().
 */
export function createThinkNode(model: Runnable) {
  return async (state: AgentStateType) => {
    try {
      const response = await model.invoke(state.messages);
      return { messages: [response] };
    } catch (e: unknown) {
      // Token limit handling (matches toolcall.py line 60-72)
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes("token") ||
        msg.includes("context_length_exceeded") ||
        msg.includes("maximum context length")
      ) {
        return {
          messages: [
            new AIMessage(
              `Maximum token limit reached, cannot continue execution: ${msg}`,
            ),
          ],
          status: "finished" as const,
        };
      }
      throw e;
    }
  };
}
