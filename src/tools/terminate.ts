/**
 * Terminate Tool — Signals the agent to stop execution.
 *
 * Translated from: app/tool/terminate.py
 *
 * In OpenManus, Terminate is a "special tool" — ToolCallAgent._handle_special_tool()
 * detects it and sets agent.state = FINISHED.
 *
 * In LangGraph, the routing function (shouldContinue) checks for this tool call
 * and routes to END. The tool itself just returns a confirmation string.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const terminate = tool(
  async ({ status }): Promise<string> => {
    return `The interaction has been completed with status: ${status}`;
  },
  {
    name: "terminate",
    description:
      "Terminate the interaction when the request is met OR if the assistant cannot proceed further with the task. When you have finished all the tasks, call this tool to end the work.",
    schema: z.object({
      status: z
        .enum(["success", "failure"])
        .describe("The finish status of the interaction."),
    }),
  },
);
