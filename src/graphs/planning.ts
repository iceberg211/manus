/**
 * Planning Flow Graph — Multi-agent orchestration with plan-based execution.
 *
 * Translated from: app/flow/planning.py PlanningFlow (443 lines)
 *
 * Graph structure:
 *
 *   START → create_plan → select_step ──→ execute_step → update_plan → select_step
 *                              │ all done                                (loop)
 *                              ↓
 *                          summarize → END
 *
 * Key behaviors preserved:
 * 1. LLM creates structured plan from user request
 * 2. Steps executed sequentially, each by an appropriate agent subgraph
 * 3. Agent selection based on [TYPE] tags in step text (regex match)
 * 4. Step status tracked: not_started → in_progress → completed
 * 5. Final summary generated after all steps complete
 */
import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { Command } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { CompiledStateGraph } from "@langchain/langgraph";
import { createLLM } from "../config/llmFactory.js";
import { createThreadConfig } from "../config/persistence.js";
import { logger } from "../utils/logger.js";

import {
  PlanState,
  type PlanStateType,
  type Plan,
  type PlanStep,
  formatPlan,
} from "../state/planState.js";
import {
  PLANNING_SYSTEM_PROMPT,
  PLAN_CREATION_PROMPT,
  SUMMARIZE_PROMPT,
} from "../prompts/planning.js";
import { planStorage } from "../tools/planningTool.js";

// ---- Types ----

interface AgentEntry {
  name: string;
  description: string;
  graph: CompiledStateGraph<any, any, any>;
}

export interface PlanningFlowOptions {
  /** 预创建的 LLM 实例（用于计划生成和总结）。不传则从 config 创建。 */
  model?: BaseChatModel;
  /** LLM 配置名。 */
  llmProfile?: string;
  /** Named agent graphs available for step execution. */
  agents: Record<string, AgentEntry>;
  /** Default agent key to use when no type match found. */
  defaultAgent?: string;
  /** Enable checkpointer. */
  checkpointer?: boolean;
}

// ---- Nodes ----

function createPlanNode(model: BaseChatModel, agentEntries: AgentEntry[]) {
  /**
   * Create an initial plan from the user's request.
   * Translated from: PlanningFlow._create_initial_plan (lines 136-211)
   */
  return async (state: PlanStateType) => {
    const lastUserMsg = [...state.messages]
      .reverse()
      .find((m) => m._getType() === "human");
    const task = lastUserMsg
      ? typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : "Complete the given task"
      : "Complete the given task";

    const agentDescs =
      agentEntries.length > 1
        ? agentEntries.map((a) => ({
            name: a.name,
            description: a.description,
          }))
        : undefined;

    const response = await model.invoke([
      new SystemMessage(PLANNING_SYSTEM_PROMPT),
      new HumanMessage(PLAN_CREATION_PROMPT(task, agentDescs)),
    ]);

    // Parse plan from LLM response
    const content =
      typeof response.content === "string" ? response.content : "";
    let plan: Plan;

    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        plan = {
          title: parsed.title || `Plan for: ${task.slice(0, 50)}`,
          steps: (parsed.steps || []).map((s: string) => ({
            text: s,
            status: "not_started" as const,
            notes: "",
          })),
        };
      } else {
        // Fallback: split by newlines and treat each as a step
        const lines = content
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => l.replace(/^\d+\.\s*/, "").trim())
          .filter((l) => l.length > 0);
        plan = {
          title: `Plan for: ${task.slice(0, 50)}`,
          steps: lines.map((l) => ({
            text: l,
            status: "not_started" as const,
            notes: "",
          })),
        };
      }
    } catch {
      // Default plan if parsing fails (matches Python's default plan logic)
      plan = {
        title: `Plan for: ${task.slice(0, 50)}`,
        steps: [
          { text: "Analyze request", status: "not_started", notes: "" },
          { text: "Execute task", status: "not_started", notes: "" },
          { text: "Verify results", status: "not_started", notes: "" },
        ],
      };
    }

    logger.info(
      `[plan] Created: "${plan.title}" with ${plan.steps.length} steps`,
    );
    return { plan };
  };
}

/**
 * Find the next step to execute and select the appropriate agent.
 * Translated from: PlanningFlow._get_current_step_info (lines 213-275)
 *                  PlanningFlow.get_executor (lines 77-92)
 *
 * Uses Command to both update state AND route to execute_step or summarize.
 */
function selectStepNode(
  agents: Record<string, AgentEntry>,
  defaultAgent: string,
) {
  return (state: PlanStateType): Command => {
    const plan = state.plan;
    if (!plan) {
      return new Command({ goto: "summarize" });
    }

    // Find first non-completed step (matches _get_current_step_info)
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (step.status === "not_started" || step.status === "in_progress") {
        // Extract [TYPE] tag from step text (matches Python regex: \[([A-Z_]+)\])
        const typeMatch = step.text.match(/\[([A-Z_]+)\]/);
        let executorType = defaultAgent;
        if (typeMatch) {
          const tag = typeMatch[1].toLowerCase();
          if (agents[tag]) executorType = tag;
        }

        // Mark step as in_progress
        const updatedPlan = { ...plan, steps: [...plan.steps] };
        updatedPlan.steps[i] = { ...step, status: "in_progress" as const };

        logger.info(
          `[plan] Step ${i}: "${step.text}" → executor: ${executorType}`,
        );

        return new Command({
          update: {
            plan: updatedPlan,
            currentStepIndex: i,
            executorType,
          },
          goto: "execute_step",
        });
      }
    }

    // All steps done
    return new Command({ goto: "summarize" });
  };
}

/**
 * Execute the current step by invoking the selected agent subgraph.
 * Translated from: PlanningFlow._execute_step (lines 277-304)
 *
 * Improvement T-3: Failed steps are marked as "failed" (not silently "completed").
 * The PlanningTool is synced with planStorage so the LLM can dynamically modify the plan.
 *
 * Bug fixes:
 * - Subgraph invoke now includes thread config (required by checkpointer)
 * - planStorage is fully synced before/after each step execution to prevent
 *   state rollback. A snapshot is taken before invoke to detect if the LLM
 *   actually modified the plan via PlanningTool.
 */
function executeStepNode(agents: Record<string, AgentEntry>) {
  return async (state: PlanStateType) => {
    const plan = state.plan!;
    const step = plan.steps[state.currentStepIndex];
    const agent = agents[state.executorType];

    if (!agent) {
      // T-3: mark as failed, not silently skip
      const failedPlan = { ...plan, steps: [...plan.steps] };
      failedPlan.steps[state.currentStepIndex] = {
        ...step,
        status: "failed" as const,
        notes: `No agent found for type '${state.executorType}'`,
      };
      return {
        plan: failedPlan,
        stepResults: [`Error: No agent found for type '${state.executorType}'`],
      };
    }

    // Sync current graph-state plan → planStorage before each step.
    // Always overwrite so storage reflects the latest statuses from graph state.
    const planId = `active_plan`;
    planStorage.syncFromGraphState(planId, plan);

    // Snapshot step texts before invoke to detect if LLM modified the plan
    const preInvokeStepTexts = plan.steps.map((s) => s.text).join("\n");

    // Build context prompt
    const planStatus = formatPlan(plan);
    const stepPrompt = `CURRENT PLAN STATUS:\n${planStatus}\n\nYOUR CURRENT TASK:\nYou are now working on step ${state.currentStepIndex}: "${step.text}"\n\nPlease execute this step using the appropriate tools. You also have access to the 'planning' tool to update the plan if needed (e.g., add new steps discovered during execution). When done, provide a summary.`;

    try {
      // Each subgraph invocation gets its own thread (required by checkpointer)
      const subConfig = createThreadConfig();
      const result = await agent.graph.invoke(
        { messages: [new HumanMessage(stepPrompt)] },
        subConfig,
      );

      const lastMsg = result.messages[result.messages.length - 1];
      const resultText =
        typeof lastMsg?.content === "string"
          ? lastMsg.content
          : `Step ${state.currentStepIndex} completed`;

      // Check if LLM modified the plan via PlanningTool during execution
      const storagePlan = planStorage.getPlan(planId);
      if (storagePlan) {
        const postInvokeStepTexts = storagePlan.steps.map((s) => s.text).join("\n");
        if (postInvokeStepTexts !== preInvokeStepTexts) {
          // LLM actually modified the plan structure — sync changes back to graph state
          return {
            plan: planStorage.clonePlan(planId)!,
            stepResults: [resultText],
          };
        }
      }

      return { stepResults: [resultText] };
    } catch (e: any) {
      // T-3: Mark failed step as "failed" instead of silently completing
      const failedPlan = { ...plan, steps: [...plan.steps] };
      failedPlan.steps[state.currentStepIndex] = {
        ...step,
        status: "failed" as const,
        notes: e.message,
      };
      return {
        plan: failedPlan,
        stepResults: [
          `Error executing step ${state.currentStepIndex}: ${e.message}`,
        ],
      };
    }
  };
}

/**
 * Mark the current step as completed (only if not already failed/blocked).
 * Translated from: PlanningFlow._mark_step_completed (lines 306-335)
 */
function updatePlanNode(state: PlanStateType) {
  const plan = state.plan;
  if (!plan || state.currentStepIndex < 0) return {};

  const currentStep = plan.steps[state.currentStepIndex];

  // T-3: Don't overwrite failed/blocked status with completed
  if (currentStep.status === "failed" || currentStep.status === "blocked") {
    logger.info(
      `[plan] Step ${state.currentStepIndex} ${currentStep.status} — skipping completion mark`
    );
    return {};
  }

  const updatedPlan = { ...plan, steps: [...plan.steps] };
  updatedPlan.steps[state.currentStepIndex] = {
    ...currentStep,
    status: "completed" as const,
  };

  logger.info(`[plan] Step ${state.currentStepIndex} completed`);
  return { plan: updatedPlan };
}

/**
 * Generate a final summary.
 * Translated from: PlanningFlow._finalize_plan (lines 406-442)
 */
function summarizeNode(model: BaseChatModel) {
  return async (state: PlanStateType) => {
    const planText = state.plan ? formatPlan(state.plan) : "No plan available";

    const response = await model.invoke([
      new SystemMessage(
        "You are a planning assistant. Summarize the completed plan.",
      ),
      new HumanMessage(`${SUMMARIZE_PROMPT}\n\n${planText}`),
    ]);

    return { messages: [response] };
  };
}

// ---- Graph builder ----

export async function createPlanningFlow(options: PlanningFlowOptions) {
  const {
    model: providedModel,
    llmProfile,
    agents,
    defaultAgent = Object.keys(agents)[0],
    checkpointer: useCheckpointer = false,
  } = options;

  const model = providedModel ?? await createLLM(llmProfile);

  const agentEntries = Object.entries(agents).map(([key, entry]) => ({
    ...entry,
    name: key,
  }));

  const graph = new StateGraph(PlanState)
    .addNode("create_plan", createPlanNode(model, agentEntries))
    .addNode(
      "select_step",
      selectStepNode(agents, defaultAgent),
      // Declare Command destinations
      { ends: ["execute_step", "summarize"] },
    )
    .addNode("execute_step", executeStepNode(agents))
    .addNode("update_plan", updatePlanNode)
    .addNode("summarize", summarizeNode(model))
    // Edges
    .addEdge(START, "create_plan")
    .addEdge("create_plan", "select_step")
    // select_step uses Command to route to execute_step or summarize
    .addEdge("execute_step", "update_plan")
    .addEdge("update_plan", "select_step") // loop back
    .addEdge("summarize", END);

  // NOTE: recursionLimit is NOT a compile() option in LangGraph TS 0.2.x.
  // It must be passed via invoke/stream config.
  const planRecursionLimit = 100; // plan can have many steps

  const compileOptions: {
    checkpointer?: MemorySaver;
  } = {};
  if (useCheckpointer) {
    compileOptions.checkpointer = new MemorySaver();
  }

  const compiled = graph.compile(compileOptions);

  // Wrap invoke/stream via Proxy so we inject recursionLimit without mutating
  // the compiled instance (prototype methods like getState keep working).
  return new Proxy(compiled, {
    get(target, prop) {
      if (prop === "invoke") {
        return (input: any, config?: any) =>
          target.invoke(input, { recursionLimit: planRecursionLimit, ...config });
      }
      if (prop === "stream") {
        return (input: any, config?: any) =>
          target.stream(input, { recursionLimit: planRecursionLimit, ...config });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
