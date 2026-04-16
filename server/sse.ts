/**
 * SSE Helper — Convert LangGraph stream events to Hono SSE format.
 */
import type { SSEStreamingApi } from "hono/streaming";
import type { SSEEvent } from "./types.js";

/** Write a single SSE event via Hono's writeSSE API. */
export async function writeSSE(
  stream: SSEStreamingApi,
  event: SSEEvent,
): Promise<void> {
  await stream.writeSSE({
    event: event.event,
    data: JSON.stringify(event.data),
  });
}

/**
 * Process a single graph stream chunk and emit SSE events.
 *
 * Maps LangGraph node names to SSE event types:
 *   think → thinking (content) + tool_call (if tool_calls present)
 *   tools → tool_result
 */
export async function processStreamChunk(
  stream: SSEStreamingApi,
  nodeName: string,
  update: any,
): Promise<void> {
  const msgs = update?.messages;
  if (!msgs?.length) return;

  if (nodeName === "think") {
    const last = msgs[msgs.length - 1];
    const content = typeof last.content === "string" ? last.content : "";
    const toolCalls = last.tool_calls ?? [];

    if (content) {
      await writeSSE(stream, {
        event: "thinking",
        data: { content },
      });
    }

    for (const tc of toolCalls) {
      await writeSSE(stream, {
        event: "tool_call",
        data: {
          id: tc.id,
          name: tc.name,
          args: tc.args,
        },
      });
    }
  } else if (nodeName === "tools") {
    for (const msg of msgs) {
      await writeSSE(stream, {
        event: "tool_result",
        data: {
          name: msg.name ?? "tool",
          content:
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content),
          toolCallId: msg.tool_call_id,
        },
      });
    }
  }
}
