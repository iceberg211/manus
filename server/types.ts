/** API request/response types. */

export interface ChatRequest {
  message: string;
  threadId?: string;
}

export interface ResumeRequest {
  threadId: string;
  answer: string;
}

/** SSE event types sent to the client. */
export type SSEEventType =
  | "thinking"      // LLM is reasoning
  | "tool_call"     // LLM decided to call a tool
  | "tool_result"   // Tool returned a result
  | "interrupt"     // Agent needs human input
  | "error"         // Something went wrong
  | "done";         // Stream complete

export interface SSEEvent {
  event: SSEEventType;
  data: Record<string, any>;
}
