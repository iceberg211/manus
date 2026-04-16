/**
 * AgentState — Core state for the ReAct agent graph.
 *
 * Maps to OpenManus concepts:
 * - messages    → Memory (message list) with auto-append reducer
 * - status      → AgentState enum (IDLE/RUNNING/FINISHED/ERROR)
 * - screenshot  → BrowserContextHelper's base64 screenshot
 *
 * Reference: app/agent/base.py (Memory, AgentState enum)
 *            app/agent/toolcall.py (_current_base64_image)
 */
import { BaseMessage } from "@langchain/core/messages";
import { Annotation, messagesStateReducer } from "@langchain/langgraph";

export const AgentState = Annotation.Root({
  /**
   * Conversation history. Uses messagesStateReducer to auto-append
   * new messages returned by nodes (replaces manual memory.add_message()).
   */
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  /**
   * Agent execution status. Conditional edges check this to route to END.
   * Replaces the AgentState enum (IDLE/RUNNING/FINISHED/ERROR) from base.py.
   */
  status: Annotation<"running" | "finished" | "stuck">({
    reducer: (_prev, next) => next,
    default: () => "running" as const,
  }),

  /**
   * Browser screenshot from the last browser action (base64 JPEG).
   * Replaces ToolCallAgent._current_base64_image.
   * Only set when BrowserUseTool is in use.
   */
  screenshot: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
});

export type AgentStateType = typeof AgentState.State;
