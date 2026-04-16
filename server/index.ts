/**
 * API Server — Hono HTTP server wrapping the agent graph.
 *
 * Endpoints:
 *   POST /api/chat          — Send message, get SSE stream back
 *   POST /api/chat/resume   — Resume from HITL interrupt
 *   GET  /api/threads       — List active threads (TODO)
 *   GET  /api/agent-card    — Agent capabilities
 *
 * Does NOT modify src/ — only imports and consumes.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { createManusAgent } from "../src/graphs/manus.js";
import { createThreadConfig } from "../src/config/persistence.js";
import { AGENT_CARD } from "../src/a2a/server.js";
import { logger } from "../src/utils/logger.js";
import { processStreamChunk, writeSSE } from "./sse.js";
import type { ChatRequest, ResumeRequest } from "./types.js";

const app = new Hono();

// CORS for Vite dev server (port 5173)
app.use("/api/*", cors({ origin: ["http://localhost:5173", "http://localhost:3000"] }));

// Lazy-init agent (created once on first request)
let agentPromise: ReturnType<typeof createManusAgent> | null = null;
function getAgent() {
  if (!agentPromise) {
    agentPromise = createManusAgent();
  }
  return agentPromise;
}

// Store thread configs for resume
const threadConfigs = new Map<string, ReturnType<typeof createThreadConfig>>();

function getOrCreateThread(threadId?: string) {
  const id = threadId ?? crypto.randomUUID();
  if (!threadConfigs.has(id)) {
    threadConfigs.set(id, createThreadConfig(id));
  }
  return { threadId: id, config: threadConfigs.get(id)! };
}

// -----------------------------------------------------------------------
// POST /api/chat — Main chat endpoint with SSE streaming
// -----------------------------------------------------------------------

app.post("/api/chat", async (c) => {
  const body = await c.req.json<ChatRequest>();
  const { message, threadId: reqThreadId } = body;

  if (!message) {
    return c.json({ error: "message is required" }, 400);
  }

  const agent = await getAgent();
  const { threadId, config } = getOrCreateThread(reqThreadId);

  return streamSSE(c, async (stream) => {
    try {
      const graphStream = await agent.stream(
        { messages: [new HumanMessage(message)] },
        { ...config, streamMode: "updates" }
      );

      for await (const event of graphStream) {
        for (const [nodeName, update] of Object.entries(event)) {
          if (nodeName === "__interrupt__") continue;
          await processStreamChunk(stream, nodeName, update);
        }
      }

      // Check for HITL interrupt
      const state = await agent.getState(config);
      if (state.tasks) {
        const interrupts = Object.values(state.tasks)
          .flatMap((t: any) => t.interrupts ?? [])
          .map((i: any) => i.value);

        if (interrupts.length > 0) {
          await writeSSE(stream, {
            event: "interrupt",
            data: {
              threadId,
              question: interrupts[0]?.question ?? "Agent needs your input",
              context: interrupts[0]?.context,
            },
          });
          return;
        }
      }

      await writeSSE(stream, { event: "done", data: { threadId } });
    } catch (e: any) {
      logger.error({ err: e }, "Chat stream error");
      await writeSSE(stream, { event: "error", data: { message: e.message } });
    }
  });
});

// -----------------------------------------------------------------------
// POST /api/chat/resume — Resume from HITL interrupt
// -----------------------------------------------------------------------

app.post("/api/chat/resume", async (c) => {
  const body = await c.req.json<ResumeRequest>();
  const { threadId, answer } = body;

  if (!threadId || !answer) {
    return c.json({ error: "threadId and answer are required" }, 400);
  }

  const agent = await getAgent();
  const thread = threadConfigs.get(threadId);
  if (!thread) {
    return c.json({ error: "Thread not found" }, 404);
  }

  return streamSSE(c, async (stream) => {
    try {
      const graphStream = await agent.stream(
        new Command({ resume: answer }),
        { ...thread, streamMode: "updates" }
      );

      for await (const event of graphStream) {
        for (const [nodeName, update] of Object.entries(event)) {
          if (nodeName === "__interrupt__") continue;
          await processStreamChunk(stream, nodeName, update);
        }
      }

      // Check for another interrupt
      const state = await agent.getState(thread);
      if (state.tasks) {
        const interrupts = Object.values(state.tasks)
          .flatMap((t: any) => t.interrupts ?? [])
          .map((i: any) => i.value);

        if (interrupts.length > 0) {
          await writeSSE(stream, {
            event: "interrupt",
            data: {
              threadId,
              question: interrupts[0]?.question ?? "Agent needs your input",
            },
          });
          return;
        }
      }

      await writeSSE(stream, { event: "done", data: { threadId } });
    } catch (e: any) {
      logger.error({ err: e }, "Resume stream error");
      await writeSSE(stream, { event: "error", data: { message: e.message } });
    }
  });
});

// -----------------------------------------------------------------------
// GET /api/agent-card — Agent capabilities
// -----------------------------------------------------------------------

app.get("/api/agent-card", (c) => c.json(AGENT_CARD));

// -----------------------------------------------------------------------
// Static files (production: serve web/dist/)
// -----------------------------------------------------------------------

// In production, serve the built React app
// app.use("/*", serveStatic({ root: "../web/dist" }));

// -----------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------

const port = parseInt(process.env.PORT ?? "3000");
logger.info({ port }, `Starting API server on http://localhost:${port}`);

serve({ fetch: app.fetch, port });
