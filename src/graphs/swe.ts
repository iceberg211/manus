/**
 * SWE Agent Graph — Software engineering focused agent.
 * Translated from: app/agent/swe.py
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { buildReactAgent } from "./reactAgent.js";
import { createLLM } from "../config/llmFactory.js";
import { getConfig } from "../config/index.js";
import { bash } from "../tools/bash.js";
import { strReplaceEditor } from "../tools/strReplaceEditor.js";
import { SWE_SYSTEM_PROMPT } from "../prompts/swe.js";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

export interface SWEAgentOptions {
  model?: BaseChatModel;
  llmProfile?: string;
  /** 额外工具（如 planningTool、MCP 动态工具）。 */
  extraTools?: StructuredToolInterface[];
  checkpointer?: boolean | BaseCheckpointSaver;
  enableHumanInTheLoop?: boolean;
}

export async function createSWEAgent(options: SWEAgentOptions = {}) {
  const {
    model,
    llmProfile,
    extraTools = [],
    checkpointer = false,
    enableHumanInTheLoop = true,
  } = options;
  const llm = model ?? await createLLM(llmProfile);
  const llmSettings = getConfig().llm[llmProfile ?? "default"] ?? getConfig().llm.default;

  return buildReactAgent({
    model: llm,
    tools: [bash, strReplaceEditor, ...extraTools],
    systemPrompt: SWE_SYSTEM_PROMPT,
    nextStepPrompt: "",
    recursionLimit: 40,
    checkpointer,
    enableHumanInTheLoop,
    maxInputTokens: llmSettings?.max_input_tokens,
  });
}
