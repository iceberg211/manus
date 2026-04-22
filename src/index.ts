import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { createInterface } from "readline";

import { createManusAgent } from "./graphs/manus.js";
import { ensureConfigLoaded } from "./config/index.js";
import { browserManager } from "./tools/browserUse.js";
import { bashSession } from "./tools/bash.js";
import { cleanupCrawler } from "./tools/crawl4ai.js";
import { createThreadConfig, resolveDefaultCheckpointer } from "./config/persistence.js";
import { logger } from "./utils/logger.js";

/**
 * A-3: 选择 checkpointer。
 * - 如果设置了 LANGGRAPH_CHECKPOINT_PG 环境变量，用 PostgresSaver
 * - 否则回退到 MemorySaver（传 true）
 *
 * PostgresSaver 的连接字符串格式：
 *   postgresql://user:pass@localhost:5432/dbname
 * 需要先安装：npm install @langchain/langgraph-checkpoint-postgres
 */
async function resolveCheckpointer(): Promise<boolean | BaseCheckpointSaver> {
  return resolveDefaultCheckpointer(logger);
}

/** Prompt user for input (for HITL resume). */
function promptUser(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n[Human Input Required] ${question}\n> `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function runWithUpdates(prompt: string, checkpointer: boolean | BaseCheckpointSaver) {
  const agent = await createManusAgent({ workDir: process.cwd(), checkpointer });
  const config = createThreadConfig();

  let input: any = { messages: [new HumanMessage(prompt)] };

  // Loop to handle HITL interrupts
  while (true) {
    const stream = await agent.stream(input, {
      ...config,
      streamMode: "updates",
    });

    let interrupted = false;

    for await (const event of stream) {
      for (const [nodeName, update] of Object.entries(event)) {
        if (nodeName === "__interrupt__") continue;

        const msgs = (update as any)?.messages;
        if (!msgs?.length) continue;

        if (nodeName === "think") {
          const last = msgs[msgs.length - 1];
          const content = typeof last.content === "string" ? last.content : "";
          const toolCalls = last.tool_calls ?? [];
          if (content) {
            console.log(
              `[think] ${content.slice(0, 300)}${content.length > 300 ? "..." : ""}`,
            );
          }
          if (toolCalls.length > 0) {
            console.log(
              `[think] Tools: ${toolCalls.map((tc: any) => tc.name).join(", ")}`,
            );
          }
        } else if (nodeName === "tools") {
          for (const msg of msgs) {
            const content = typeof msg.content === "string" ? msg.content : "";
            console.log(
              `[${msg.name ?? "tool"}] ${content.slice(0, 400)}${content.length > 400 ? "..." : ""}`,
            );
          }
        } else if (nodeName === "human_review") {
          // This won't actually appear — interrupt stops the stream
        }
      }
    }

    // Check if graph is interrupted (HITL)
    const state = await agent.getState(config);
    if (
      state.tasks &&
      Object.values(state.tasks).some(
        (t: any) => t.interrupts && t.interrupts.length > 0,
      )
    ) {
      // Extract interrupt value
      const interruptData = Object.values(state.tasks)
        .flatMap((t: any) => t.interrupts ?? [])
        .map((i: any) => i.value);

      const question =
        interruptData[0]?.question ?? "What would you like to do?";
      const answer = await promptUser(question);
      input = new Command({ resume: answer });
      interrupted = true;
    }

    if (!interrupted) break;
  }
}

async function runWithTokens(prompt: string, checkpointer: boolean | BaseCheckpointSaver) {
  const agent = await createManusAgent({ workDir: process.cwd(), checkpointer });
  const config = createThreadConfig();

  let input: any = { messages: [new HumanMessage(prompt)] };

  // Loop to handle HITL interrupts (same pattern as runWithUpdates)
  while (true) {
    const stream = await agent.stream(input, {
      ...config,
      streamMode: "messages",
    });

    for await (const chunk of stream) {
      const [token] = chunk;
      if (token && typeof token.content === "string" && token.content) {
        process.stdout.write(token.content);
      }
    }
    console.log(); // Newline after stream ends

    // Check if graph is interrupted (HITL)
    const state = await agent.getState(config);
    if (
      state.tasks &&
      Object.values(state.tasks).some(
        (t: any) => t.interrupts && t.interrupts.length > 0,
      )
    ) {
      const interruptData = Object.values(state.tasks)
        .flatMap((t: any) => t.interrupts ?? [])
        .map((i: any) => i.value);

      const question =
        interruptData[0]?.question ?? "What would you like to do?";
      const answer = await promptUser(question);
      input = new Command({ resume: answer });
    } else {
      break;
    }
  }
}

async function runInvoke(prompt: string, checkpointer: boolean | BaseCheckpointSaver) {
  const agent = await createManusAgent({ workDir: process.cwd(), checkpointer });
  const config = createThreadConfig();

  const result = await agent.invoke(
    { messages: [new HumanMessage(prompt)] },
    config,
  );

  const lastMsg = result.messages[result.messages.length - 1];
  if (lastMsg) {
    console.log(
      typeof lastMsg.content === "string"
        ? lastMsg.content
        : JSON.stringify(lastMsg.content),
    );
  }
}

async function main() {
  await ensureConfigLoaded();

  const args = process.argv.slice(2);
  const mode = args.find((a) => a.startsWith("--"));
  const prompt =
    args.filter((a) => !a.startsWith("--")).join(" ") ||
    "List the files in the current directory and tell me what you see.";

  console.log(`\n--- OpenManus (LangGraph TS) ---`);
  console.log(`Working directory: ${process.cwd()}`);
  console.log(`Task: ${prompt}`);
  console.log(
    `Mode: ${mode === "--tokens" ? "token stream" : mode === "--invoke" ? "invoke" : "updates stream"}\n`,
  );
  console.log("--- Execution Start ---\n");

  const checkpointer = await resolveCheckpointer();

  try {
    if (mode === "--tokens") {
      await runWithTokens(prompt, checkpointer);
    } else if (mode === "--invoke") {
      await runInvoke(prompt, checkpointer);
    } else {
      await runWithUpdates(prompt, checkpointer);
    }
    console.log("\n--- Execution Complete ---");
  } finally {
    await runCleanup();
  }
}

/**
 * Run all cleanup tasks independently so a single failure doesn't prevent
 * others from running. Each failure is logged but not rethrown.
 */
async function runCleanup(): Promise<void> {
  const tasks: Array<[string, () => unknown | Promise<unknown>]> = [
    ["browserManager", () => browserManager.cleanup()],
    ["bashSession", () => bashSession.stop()],
    ["crawl4ai", () => cleanupCrawler()],
  ];
  const results = await Promise.allSettled(tasks.map(([, fn]) => fn()));
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`[cleanup] ${tasks[i][0]} failed:`, r.reason);
    }
  });
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
