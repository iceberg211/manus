export type MessageRole = "user" | "assistant" | "tool_call" | "tool_result" | "interrupt" | "error";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolName?: string;
  toolArgs?: Record<string, any>;
  toolCallId?: string;
  timestamp: number;
}

export interface InterruptState {
  question: string;
  threadId: string;
  context?: string;
}

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  messageCount: number;
}
