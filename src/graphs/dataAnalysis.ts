/**
 * Data Analysis Agent Graph — Data analysis and visualization.
 * Translated from: app/agent/data_analysis.py
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { buildReactAgent } from "./reactAgent.js";
import { createLLM } from "../config/llmFactory.js";
import { getConfig } from "../config/index.js";
import { codeExecute } from "../tools/codeExecute.js";
import { bash } from "../tools/bash.js";
import { chartVisualization, visualizationPrepare } from "../tools/chartVisualization.js";
import { DATA_ANALYSIS_SYSTEM_PROMPT, DATA_ANALYSIS_NEXT_STEP_PROMPT } from "../prompts/dataAnalysis.js";

export interface DataAnalysisAgentOptions {
  model?: BaseChatModel;
  llmProfile?: string;
  workDir?: string;
  /** 额外工具（如 planningTool、MCP 动态工具）。 */
  extraTools?: StructuredToolInterface[];
  checkpointer?: boolean | BaseCheckpointSaver;
  enableHumanInTheLoop?: boolean;
}

export async function createDataAnalysisAgent(options: DataAnalysisAgentOptions = {}) {
  const {
    workDir = process.cwd(),
    extraTools = [],
    checkpointer = false,
    enableHumanInTheLoop = true,
  } = options;
  const llm = options.model ?? await createLLM(options.llmProfile);
  const llmSettings = getConfig().llm[options.llmProfile ?? "default"] ?? getConfig().llm.default;

  return buildReactAgent({
    model: llm,
    tools: [codeExecute, bash, visualizationPrepare, chartVisualization, ...extraTools],
    systemPrompt: DATA_ANALYSIS_SYSTEM_PROMPT(workDir),
    nextStepPrompt: DATA_ANALYSIS_NEXT_STEP_PROMPT,
    maxObserve: 15000,
    recursionLimit: 40,
    checkpointer,
    enableHumanInTheLoop,
    maxInputTokens: llmSettings?.max_input_tokens,
  });
}
