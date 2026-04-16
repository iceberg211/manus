/**
 * Planning Flow entry point — Multi-agent orchestration.
 *
 * Translated from: run_flow.py
 *
 * Creates a PlanningFlow with multiple agent types and runs it.
 * Equivalent to: FlowFactory.create_flow(PLANNING) → execute(prompt)
 */
import { HumanMessage } from "@langchain/core/messages";
import { createPlanningFlow } from "./graphs/planning.js";
import { createManusAgent } from "./graphs/manus.js";
import { createSWEAgent } from "./graphs/swe.js";
import { createDataAnalysisAgent } from "./graphs/dataAnalysis.js";
import { browserManager } from "./tools/browserUse.js";
import { bashSession } from "./tools/bash.js";
import { cleanupCrawler } from "./tools/crawl4ai.js";
import { planningTool } from "./tools/planningTool.js";

async function main() {
  const prompt =
    process.argv[2] ||
    "Create a Python script that calculates fibonacci numbers and save it to workspace/fib.py";

  console.log(`\n--- OpenManus Planning Flow (LangGraph TS) ---`);
  console.log(`Task: ${prompt}\n`);

  // Sub-executors inside a planning flow don't own HITL — the planning layer
  // does. Disabling ask_human here prevents sub-graphs from calling interrupt()
  // (which would need a checkpointer they intentionally don't have, to avoid
  // per-step thread checkpoints accumulating forever in MemorySaver).
  //
  // Also inject planningTool so executor 的 stepPrompt 里承诺的 "planning tool"
  // 是真工具（IMPROVEMENTS.md: PlanningTool 未挂到 executor agent）。
  const sharedTools = [planningTool];

  const flow = await createPlanningFlow({
    agents: {
      manus: {
        name: "manus",
        description: "A versatile agent that can solve various tasks using multiple tools",
        graph: await createManusAgent({ enableHumanInTheLoop: false, extraTools: sharedTools }),
      },
      swe: {
        name: "swe",
        description: "An autonomous AI programmer for code editing and bash commands",
        graph: await createSWEAgent({ enableHumanInTheLoop: false, extraTools: sharedTools }),
      },
      data: {
        name: "data",
        description: "A data analysis agent for analyzing data and creating visualizations",
        graph: await createDataAnalysisAgent({ enableHumanInTheLoop: false, extraTools: sharedTools }),
      },
    },
    defaultAgent: "manus",
  });

  console.log("--- Planning Flow Start ---\n");

  try {
    const result = await flow.invoke({
      messages: [new HumanMessage(prompt)],
    });

    console.log("\n--- Planning Flow Complete ---\n");

    const lastMsg = result.messages[result.messages.length - 1];
    if (lastMsg) {
      console.log(
        "Summary:",
        typeof lastMsg.content === "string"
          ? lastMsg.content
          : JSON.stringify(lastMsg.content)
      );
    }
  } finally {
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
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
