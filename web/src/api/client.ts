/**
 * API Client — SSE streaming client for the agent API.
 */
import type { ChatMessage, InterruptState } from "../types.js";

type SSECallback = {
  onThinking: (content: string) => void;
  onToolCall: (name: string, args: any, id: string) => void;
  onToolResult: (name: string, content: string, toolCallId: string) => void;
  onInterrupt: (interrupt: InterruptState) => void;
  onError: (message: string) => void;
  onDone: (threadId: string) => void;
};

/**
 * Send a chat message and stream the response via SSE.
 */
export async function sendChat(
  message: string,
  threadId: string | undefined,
  callbacks: SSECallback
): Promise<void> {
  const resp = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, threadId }),
  });

  if (!resp.ok || !resp.body) {
    callbacks.onError(`HTTP ${resp.status}`);
    return;
  }

  await processSSEStream(resp.body, callbacks);
}

/**
 * Resume a paused chat (HITL).
 */
export async function resumeChat(
  threadId: string,
  answer: string,
  callbacks: SSECallback
): Promise<void> {
  const resp = await fetch("/api/chat/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId, answer }),
  });

  if (!resp.ok || !resp.body) {
    callbacks.onError(`HTTP ${resp.status}`);
    return;
  }

  await processSSEStream(resp.body, callbacks);
}

/** Parse an SSE stream and dispatch callbacks. */
async function processSSEStream(body: ReadableStream, callbacks: SSECallback) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    let currentEvent = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ") && currentEvent) {
        try {
          const data = JSON.parse(line.slice(6));
          switch (currentEvent) {
            case "thinking":
              callbacks.onThinking(data.content);
              break;
            case "tool_call":
              callbacks.onToolCall(data.name, data.args, data.id);
              break;
            case "tool_result":
              callbacks.onToolResult(data.name, data.content, data.toolCallId);
              break;
            case "interrupt":
              callbacks.onInterrupt({ question: data.question, threadId: data.threadId, context: data.context });
              break;
            case "error":
              callbacks.onError(data.message);
              break;
            case "done":
              callbacks.onDone(data.threadId);
              break;
          }
        } catch { /* skip malformed */ }
        currentEvent = "";
      }
    }
  }
}
