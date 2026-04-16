/**
 * Manus Agent Graph — General-purpose agent with all tools.
 *
 * Translated from: app/agent/manus.py (166 lines)
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

import { buildReactAgent } from "./reactAgent.js";
import { createLLM } from "../config/llmFactory.js";
import { getConfig } from "../config/index.js";
import { bash } from "../tools/bash.js";
import { codeExecute } from "../tools/codeExecute.js";
import { strReplaceEditor } from "../tools/strReplaceEditor.js";
import { webSearch } from "../tools/webSearch.js";
import { browserUse } from "../tools/browserUse.js";
import { crawl4ai } from "../tools/crawl4ai.js";
import { MANUS_SYSTEM_PROMPT, MANUS_NEXT_STEP_PROMPT } from "../prompts/manus.js";

export interface ManusOptions {
  /** 预创建的 LLM 实例。不传则从 config 自动创建。 */
  model?: BaseChatModel;
  /** LLM 配置名（对应 config.toml 的 [llm.xxx]）。默认 "default"。 */
  llmProfile?: string;
  /** 工作目录。 */
  workDir?: string;
  /** 额外工具（如 MCP 动态工具）。 */
  extraTools?: StructuredToolInterface[];
  /** 启用 checkpointer。传 true 默认 MemorySaver；传实例用于 PostgresSaver 等。 */
  checkpointer?: boolean | BaseCheckpointSaver;
  /** 启用 ask_human 工具（HITL）。默认 true。设为 false 可避免子图 interrupt。 */
  enableHumanInTheLoop?: boolean;
}

export async function createManusAgent(options: ManusOptions = {}) {
  const {
    model,
    llmProfile,
    workDir = process.cwd(),
    extraTools = [],
    checkpointer = false,
    enableHumanInTheLoop = true,
  } = options;

  const llm = model ?? await createLLM(llmProfile);

  // A-1: 从 config 读取 max_input_tokens，配合 trimMessages 避免长任务失败
  const llmSettings = getConfig().llm[llmProfile ?? "default"] ?? getConfig().llm.default;
  const maxInputTokens = llmSettings?.max_input_tokens;

  return buildReactAgent({
    model: llm,
    tools: [codeExecute, bash, browserUse, strReplaceEditor, webSearch, crawl4ai, ...extraTools],
    systemPrompt: MANUS_SYSTEM_PROMPT(workDir),
    nextStepPrompt: MANUS_NEXT_STEP_PROMPT,
    maxObserve: 10000,
    recursionLimit: 40,
    checkpointer,
    enableHumanInTheLoop,
    maxInputTokens,
    // A-6: Manus 集成 browser_use，开启上下文注入 — 只有最近用过浏览器时才真正注入
    browserContextEnabled: true,
  });
}
