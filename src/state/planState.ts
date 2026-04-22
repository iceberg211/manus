/**
 * PlanState — State for the Planning Flow (multi-agent orchestration).
 *
 * Translated from: app/flow/planning.py PlanStepStatus + PlanningFlow state
 *                  app/tool/planning.py plan data structure
 */
import { BaseMessage } from "@langchain/core/messages";
import { Annotation, messagesStateReducer } from "@langchain/langgraph";

/**
 * Plan step status values.
 * Extends original PlanStepStatus enum with "failed" (improvement T-3).
 */
export type StepStatus = "not_started" | "in_progress" | "completed" | "blocked" | "failed";

export const STATUS_MARKS: Record<StepStatus, string> = {
  completed: "[✓]",
  in_progress: "[→]",
  blocked: "[!]",
  failed: "[✗]",
  not_started: "[ ]",
};

/** Single plan step. */
export interface PlanStep {
  text: string;
  status: StepStatus;
  notes: string;
  type?: string; // executor type hint, e.g. "swe", "data"
}

/** The plan object. */
export interface Plan {
  title: string;
  steps: PlanStep[];
}

export const PlanState = Annotation.Root({
  /** Conversation history. */
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  /** The current plan. Created by create_plan node. */
  plan: Annotation<Plan | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /** 当前计划的稳定 ID，用于隔离 planningTool 的存储命名空间。 */
  planId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),

  /** Index of the step currently being executed. -1 = no active step. */
  currentStepIndex: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => -1,
  }),

  /** Which executor type to use for the current step. */
  executorType: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "manus",
  }),

  /** Accumulated results from each step execution. */
  stepResults: Annotation<string[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

export type PlanStateType = typeof PlanState.State;

/** Format a plan for display (matches PlanningTool._format_plan). */
export function formatPlan(plan: Plan): string {
  const total = plan.steps.length;
  const completed = plan.steps.filter((s) => s.status === "completed").length;
  const inProgress = plan.steps.filter((s) => s.status === "in_progress").length;
  const blocked = plan.steps.filter((s) => s.status === "blocked").length;
  const notStarted = plan.steps.filter((s) => s.status === "not_started").length;
  const pct = total > 0 ? ((completed / total) * 100).toFixed(1) : "0";

  let out = `Plan: ${plan.title}\n`;
  out += "=".repeat(out.length) + "\n\n";
  out += `Progress: ${completed}/${total} steps completed (${pct}%)\n`;
  out += `Status: ${completed} completed, ${inProgress} in progress, ${blocked} blocked, ${notStarted} not started\n\n`;
  out += "Steps:\n";

  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i];
    const mark = STATUS_MARKS[s.status];
    out += `${i}. ${mark} ${s.text}\n`;
    if (s.notes) out += `   Notes: ${s.notes}\n`;
  }

  return out;
}
