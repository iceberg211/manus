/**
 * SWE Agent Graph — Software engineering focused agent.
 * Translated from: app/agent/swe.py
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { buildReactAgent } from "./reactAgent.js";
import { createLLM } from "../config/llmFactory.js";
import { bash } from "../tools/bash.js";
import { strReplaceEditor } from "../tools/strReplaceEditor.js";
import { SWE_SYSTEM_PROMPT } from "../prompts/swe.js";

export interface SWEAgentOptions {
  model?: BaseChatModel;
  llmProfile?: string;
  checkpointer?: boolean;
  enableHumanInTheLoop?: boolean;
}

export async function createSWEAgent(options: SWEAgentOptions = {}) {
  const {
    model,
    llmProfile,
    checkpointer = false,
    enableHumanInTheLoop = true,
  } = options;
  const llm = model ?? await createLLM(llmProfile);

  return buildReactAgent({
    model: llm,
    tools: [bash, strReplaceEditor],
    systemPrompt: SWE_SYSTEM_PROMPT,
    nextStepPrompt: "",
    recursionLimit: 40,
    checkpointer,
    enableHumanInTheLoop,
  });
}
