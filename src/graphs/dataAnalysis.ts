/**
 * Data Analysis Agent Graph — Data analysis and visualization.
 * Translated from: app/agent/data_analysis.py
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { buildReactAgent } from "./reactAgent.js";
import { createLLM } from "../config/llmFactory.js";
import { codeExecute } from "../tools/codeExecute.js";
import { bash } from "../tools/bash.js";
import { chartVisualization, visualizationPrepare } from "../tools/chartVisualization.js";
import { DATA_ANALYSIS_SYSTEM_PROMPT, DATA_ANALYSIS_NEXT_STEP_PROMPT } from "../prompts/dataAnalysis.js";

export interface DataAnalysisAgentOptions {
  model?: BaseChatModel;
  llmProfile?: string;
  workDir?: string;
}

export async function createDataAnalysisAgent(options: DataAnalysisAgentOptions = {}) {
  const { workDir = process.cwd() } = options;
  const llm = options.model ?? await createLLM(options.llmProfile);

  return buildReactAgent({
    model: llm,
    tools: [codeExecute, bash, visualizationPrepare, chartVisualization],
    systemPrompt: DATA_ANALYSIS_SYSTEM_PROMPT(workDir),
    nextStepPrompt: DATA_ANALYSIS_NEXT_STEP_PROMPT,
    maxObserve: 15000,
    recursionLimit: 40,
  });
}
