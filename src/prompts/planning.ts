/**
 * Planning prompts.
 *
 * Translated from: app/flow/planning.py (lines 140-160)
 *                  app/prompt/planning.py
 */

export const PLANNING_SYSTEM_PROMPT = `You are a planning assistant. Create a concise, actionable plan with clear steps.
Focus on key milestones rather than detailed sub-steps.
Optimize for clarity and efficiency.`;

export const PLAN_CREATION_PROMPT = (
  task: string,
  agentDescriptions?: { name: string; description: string }[]
) => {
  let prompt = `Create a reasonable plan with clear steps to accomplish the task: ${task}

Return your plan as a JSON object with:
- "title": a short title for the plan
- "steps": an array of step strings

Each step should be a clear, actionable instruction.`;

  if (agentDescriptions && agentDescriptions.length > 1) {
    prompt += `\n\nAvailable agents:\n${agentDescriptions.map((a) => `- [${a.name.toUpperCase()}]: ${a.description}`).join("\n")}`;
    prompt += `\nWhen creating steps, prefix with the agent name in brackets, e.g. [SWE] Fix the bug`;
  }

  return prompt;
};

export const SUMMARIZE_PROMPT = `The plan has been completed. Please provide a summary of what was accomplished and any final thoughts.`;
