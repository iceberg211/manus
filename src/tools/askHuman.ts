/**
 * AskHuman Tool — Schema-only tool for human-in-the-loop.
 *
 * Translated from: app/tool/ask_human.py
 *
 * This tool is never actually executed by ToolNode.
 * When the LLM calls it, the routing function detects it and
 * redirects to the humanReview node which uses interrupt().
 *
 * The tool definition exists so the LLM knows it can ask for human input.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const askHuman = tool(
  async ({ inquire }): Promise<string> => {
    // This should never be called directly — humanReview node handles it via interrupt()
    return `[ask_human] ${inquire}`;
  },
  {
    name: "ask_human",
    description: "Use this tool to ask the human for help or clarification. Only use in extreme cases when you cannot proceed without human input.",
    schema: z.object({
      inquire: z
        .string()
        .describe("The question you want to ask the human."),
    }),
  }
);
