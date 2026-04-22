/**
 * Unified prompt exports.
 *
 * All agent prompts accessible from a single import:
 *   import { PROMPTS } from "@/prompts/index";
 *   PROMPTS.manus.system(workDir)
 */
export * from "@/prompts/manus";
export * from "@/prompts/swe";
export * from "@/prompts/dataAnalysis";
export * from "@/prompts/planning";

/** Prompt for generic tool-calling agent (from app/prompt/toolcall.py). */
export const TOOLCALL_SYSTEM_PROMPT = "You are an agent that can execute tool calls.";
export const TOOLCALL_NEXT_STEP_PROMPT =
  "Analyze the results and determine if you need to take additional actions or if the task is complete.";

/** Prompt for MCP agent (from app/prompt/mcp.py). */
export const MCP_SYSTEM_PROMPT = `You are an AI agent with access to tools provided by MCP (Model Context Protocol) servers.
Use the available tools to complete the user's request.
If a tool returns an error, try to understand the error and adjust your approach.
Some tools may return multimedia content (images, files) — describe what you received.`;
