/**
 * PlanningTool — LLM-callable plan management with 7 CRUD commands.
 *
 * Translated from: app/tool/planning.py (364 lines)
 *
 * This is an LLM-callable tool (not just state). The LLM can:
 * - Create plans with structured steps
 * - Update plans dynamically during execution (add/remove/reorder steps)
 * - Track step status (not_started → in_progress → completed → blocked/failed)
 * - Annotate steps with notes
 * - Manage multiple plans with active plan switching
 *
 * Improvement over Python original (T-3):
 * - Added "failed" status for steps that error during execution
 *
 * The tool stores plans in-memory. It can be shared across graph invocations
 * within the same process by passing the same instance to multiple agents.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StepStatus =
  | "not_started"
  | "in_progress"
  | "completed"
  | "blocked"
  | "failed"; // T-3: added failed status

export interface PlanStep {
  text: string;
  status: StepStatus;
  notes: string;
}

export interface Plan {
  plan_id: string;
  title: string;
  steps: PlanStep[];
}

const STATUS_MARKS: Record<StepStatus, string> = {
  completed: "[✓]",
  in_progress: "[→]",
  blocked: "[!]",
  failed: "[✗]",
  not_started: "[ ]",
};

// ---------------------------------------------------------------------------
// In-memory storage (matches Python's plans: dict = {})
// ---------------------------------------------------------------------------

export class PlanStorage {
  private plans = new Map<string, Plan>();
  private activePlanId: string | null = null;

  create(planId: string, title: string, steps: string[]): string {
    if (this.plans.has(planId)) {
      return `Error: A plan with ID '${planId}' already exists. Use 'update' to modify existing plans.`;
    }
    if (!title) return "Error: Parameter `title` is required for command: create";
    if (!steps?.length) return "Error: Parameter `steps` must be a non-empty list of strings for command: create";

    const plan: Plan = {
      plan_id: planId,
      title,
      steps: steps.map((s) => ({ text: s, status: "not_started" as const, notes: "" })),
    };
    this.plans.set(planId, plan);
    this.activePlanId = planId;
    return `Plan created successfully with ID: ${planId}\n\n${this.formatPlan(plan)}`;
  }

  update(planId: string, title?: string, steps?: string[]): string {
    if (!planId) return "Error: Parameter `plan_id` is required for command: update";
    const existing = this.plans.get(planId);
    if (!existing) return `Error: No plan found with ID: ${planId}`;

    // Clone before mutation to protect checkpoint references
    const plan: Plan = {
      plan_id: existing.plan_id,
      title: title || existing.title,
      steps: existing.steps.map((s) => ({ ...s })),
    };

    if (steps?.length) {
      // Preserve statuses for unchanged steps (matches Python logic lines 183-203)
      const oldSteps = plan.steps;
      plan.steps = steps.map((text, i) => {
        if (i < oldSteps.length && text === oldSteps[i].text) {
          return { ...oldSteps[i] }; // preserve status & notes
        }
        return { text, status: "not_started" as const, notes: "" };
      });
    }

    this.plans.set(planId, plan);
    return `Plan updated successfully: ${planId}\n\n${this.formatPlan(plan)}`;
  }

  list(): string {
    if (this.plans.size === 0) {
      return "No plans available. Create a plan with the 'create' command.";
    }
    let output = "Available plans:\n";
    for (const [id, plan] of this.plans) {
      const marker = id === this.activePlanId ? " (active)" : "";
      const completed = plan.steps.filter((s) => s.status === "completed").length;
      output += `- ${id}${marker}: ${plan.title} — ${completed}/${plan.steps.length} steps completed\n`;
    }
    return output;
  }

  get(planId?: string): string {
    const id = planId || this.activePlanId;
    if (!id) return "Error: No active plan. Please specify a plan_id or set an active plan.";
    const plan = this.plans.get(id);
    if (!plan) return `Error: No plan found with ID: ${id}`;
    return this.formatPlan(plan);
  }

  setActive(planId: string): string {
    if (!planId) return "Error: Parameter `plan_id` is required for command: set_active";
    if (!this.plans.has(planId)) return `Error: No plan found with ID: ${planId}`;
    this.activePlanId = planId;
    return `Plan '${planId}' is now the active plan.\n\n${this.formatPlan(this.plans.get(planId)!)}`;
  }

  markStep(
    planId: string | undefined,
    stepIndex: number,
    stepStatus?: StepStatus,
    stepNotes?: string
  ): string {
    const id = planId || this.activePlanId;
    if (!id) return "Error: No active plan. Please specify a plan_id or set an active plan.";
    const existing = this.plans.get(id);
    if (!existing) return `Error: No plan found with ID: ${id}`;
    if (stepIndex < 0 || stepIndex >= existing.steps.length) {
      return `Error: Invalid step_index: ${stepIndex}. Valid range: 0 to ${existing.steps.length - 1}.`;
    }
    // Clone before mutation to protect checkpoint references
    const plan: Plan = {
      ...existing,
      steps: existing.steps.map((s) => ({ ...s })),
    };
    if (stepStatus) plan.steps[stepIndex].status = stepStatus;
    if (stepNotes) plan.steps[stepIndex].notes = stepNotes;
    this.plans.set(id, plan);
    return `Step ${stepIndex} updated in plan '${id}'.\n\n${this.formatPlan(plan)}`;
  }

  delete(planId: string): string {
    if (!planId) return "Error: Parameter `plan_id` is required for command: delete";
    if (!this.plans.has(planId)) return `Error: No plan found with ID: ${planId}`;
    this.plans.delete(planId);
    if (this.activePlanId === planId) this.activePlanId = null;
    return `Plan '${planId}' has been deleted.`;
  }

  // --- Helpers ---

  formatPlan(plan: Plan): string {
    const total = plan.steps.length;
    const completed = plan.steps.filter((s) => s.status === "completed").length;
    const inProgress = plan.steps.filter((s) => s.status === "in_progress").length;
    const blocked = plan.steps.filter((s) => s.status === "blocked").length;
    const failed = plan.steps.filter((s) => s.status === "failed").length;
    const notStarted = plan.steps.filter((s) => s.status === "not_started").length;
    const pct = total > 0 ? ((completed / total) * 100).toFixed(1) : "0";

    let out = `Plan: ${plan.title} (ID: ${plan.plan_id})\n`;
    out += "=".repeat(out.length) + "\n\n";
    out += `Progress: ${completed}/${total} steps completed (${pct}%)\n`;
    out += `Status: ${completed} completed, ${inProgress} in progress, ${blocked} blocked, ${failed} failed, ${notStarted} not started\n\n`;
    out += "Steps:\n";

    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i];
      const mark = STATUS_MARKS[s.status];
      out += `${i}. ${mark} ${s.text}\n`;
      if (s.notes) out += `   Notes: ${s.notes}\n`;
    }
    return out;
  }

  /** Get raw plan data (for integration with planning graph state). */
  getPlan(planId?: string): Plan | null {
    const id = planId || this.activePlanId;
    if (!id) return null;
    return this.plans.get(id) ?? null;
  }

  /** Get a deep clone of a plan (safe for graph state without shared references). */
  clonePlan(planId?: string): Plan | null {
    const plan = this.getPlan(planId);
    if (!plan) return null;
    return {
      plan_id: plan.plan_id,
      title: plan.title,
      steps: plan.steps.map((s) => ({ ...s })),
    };
  }

  /**
   * Sync a plan from the planning graph state into storage.
   * Overwrites the storage entry so it reflects the latest graph-state statuses.
   * Called by executeStepNode before each subgraph invocation.
   */
  syncFromGraphState(planId: string, graphPlan: { title: string; steps: { text: string; status: string; notes: string }[] }): void {
    const plan: Plan = {
      plan_id: planId,
      title: graphPlan.title,
      steps: graphPlan.steps.map((s) => ({
        text: s.text,
        status: s.status as StepStatus,
        notes: s.notes,
      })),
    };
    this.plans.set(planId, plan);
    this.activePlanId = planId;
  }

  get activeId(): string | null {
    return this.activePlanId;
  }
}

// ---------------------------------------------------------------------------
// Singleton storage (shared across tool invocations)
// ---------------------------------------------------------------------------

export const planStorage = new PlanStorage();

// ---------------------------------------------------------------------------
// LangChain tool definition
// ---------------------------------------------------------------------------

export const planningTool = tool(
  async ({
    command,
    plan_id,
    title,
    steps,
    step_index,
    step_status,
    step_notes,
  }): Promise<string> => {
    switch (command) {
      case "create":
        if (!plan_id) return "Error: Parameter `plan_id` is required for command: create";
        return planStorage.create(plan_id, title, steps);
      case "update":
        return planStorage.update(plan_id, title, steps);
      case "list":
        return planStorage.list();
      case "get":
        return planStorage.get(plan_id);
      case "set_active":
        return planStorage.setActive(plan_id);
      case "mark_step":
        if (step_index < 0) return "Error: Parameter `step_index` is required for command: mark_step";
        return planStorage.markStep(plan_id, step_index, step_status as StepStatus | undefined, step_notes);
      case "delete":
        return planStorage.delete(plan_id);
      default:
        return `Error: Unrecognized command: ${command}. Allowed: create, update, list, get, set_active, mark_step, delete`;
    }
  },
  {
    name: "planning",
    description: `A planning tool for creating and managing task plans.
Commands:
- create: Create a new plan with title and steps
- update: Modify an existing plan's title or steps (preserves status of unchanged steps)
- list: List all plans with progress
- get: Get details of a specific plan (defaults to active plan)
- set_active: Set a plan as the active plan
- mark_step: Update a step's status and/or notes
- delete: Remove a plan`,
    schema: z.object({
      command: z
        .enum(["create", "update", "list", "get", "set_active", "mark_step", "delete"])
        .describe("The command to execute."),
      plan_id: z
        .string()
        .default("")
        .describe("Plan ID. Required for create/update/set_active/delete. Optional for get/mark_step (uses active plan)."),
      title: z
        .string()
        .default("")
        .describe("Plan title. Required for create, optional for update."),
      steps: z
        .array(z.string())
        .default([])
        .describe("List of step descriptions. Required for create, optional for update."),
      step_index: z
        .number()
        .default(-1)
        .describe("Step index (0-based). Required for mark_step."),
      step_status: z
        .string()
        .default("")
        .describe("Step status: not_started, in_progress, completed, blocked, failed. Used with mark_step."),
      step_notes: z
        .string()
        .default("")
        .describe("Additional notes for a step. Used with mark_step."),
    }),
  }
);
