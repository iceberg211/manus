/**
 * Stuck Detection — Checks if agent is repeating itself.
 *
 * Translated from: app/agent/base.py BaseAgent.is_stuck() (lines 170-186)
 *                  app/agent/base.py BaseAgent.handle_stuck_state() (lines 163-168)
 *
 * Behavior:
 * - Counts consecutive identical assistant (AI) messages
 * - Threshold: 2 duplicates (matches base.py duplicate_threshold = 2)
 * - On stuck: injects a strategy-change prompt (matches handle_stuck_state)
 */
import { HumanMessage } from "@langchain/core/messages";
import type { AgentStateType } from "@/state/agentState";
import { AGENT } from "@/config/constants";

const DUPLICATE_THRESHOLD = AGENT.DUPLICATE_THRESHOLD;
const UNSTUCK_PROMPT = AGENT.UNSTUCK_PROMPT;

/**
 * Check if the agent is stuck by looking at recent AI messages.
 * Returns "inject_unstuck" if stuck, "think" otherwise.
 *
 * Used as a conditional edge routing function after the tools node.
 */
export function checkStuck(state: AgentStateType): "inject_unstuck" | "think" {
  const msgs = state.messages;
  if (msgs.length < 2) return "think";

  // Get the last AI message with content
  const lastAI = [...msgs]
    .reverse()
    .find((m) => m._getType() === "ai" && m.content);
  if (!lastAI || !lastAI.content) return "think";

  // Count identical content in previous AI messages
  const duplicateCount = msgs.filter(
    (m) =>
      m._getType() === "ai" && m.content === lastAI.content && m !== lastAI,
  ).length;

  return duplicateCount >= DUPLICATE_THRESHOLD ? "inject_unstuck" : "think";
}

/**
 * Node that injects a strategy-change prompt when stuck.
 * Matches BaseAgent.handle_stuck_state() which prepends to next_step_prompt.
 */
export function injectUnstuck(_state: AgentStateType) {
  return {
    messages: [new HumanMessage(UNSTUCK_PROMPT)],
  };
}
