/**
 * SandboxManus Agent — Agent variant running in Docker sandbox.
 * Translated from: app/agent/sandbox_agent.py
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { buildReactAgent } from "./reactAgent.js";
import { createLLM } from "../config/llmFactory.js";
import { sandboxShell } from "../tools/sandbox/sbShellTool.js";
import { sandboxFiles } from "../tools/sandbox/sbFilesTool.js";
import { sandboxBrowser } from "../tools/sandbox/sbBrowserTool.js";
import { sandboxVision } from "../tools/sandbox/sbVisionTool.js";
import { MANUS_SYSTEM_PROMPT, MANUS_NEXT_STEP_PROMPT } from "../prompts/manus.js";
import { SANDBOX_CLIENT } from "../sandbox/docker.js";
import { logger } from "../utils/logger.js";

export interface SandboxManusOptions {
  model?: BaseChatModel;
  llmProfile?: string;
  sandboxImage?: string;
}

export async function createSandboxManusAgent(options: SandboxManusOptions = {}) {
  const llm = options.model ?? await createLLM(options.llmProfile);

  if (!SANDBOX_CLIENT.isReady) {
    await SANDBOX_CLIENT.create(options.sandboxImage ? { image: options.sandboxImage } : undefined);
    logger.info("Sandbox created for SandboxManus agent");
  }

  return buildReactAgent({
    model: llm,
    tools: [sandboxShell, sandboxFiles, sandboxBrowser, sandboxVision],
    systemPrompt: MANUS_SYSTEM_PROMPT("/workspace"),
    nextStepPrompt: MANUS_NEXT_STEP_PROMPT,
    maxObserve: 10000,
    recursionLimit: 40,
  });
}

export async function cleanupSandboxManus(): Promise<void> {
  await SANDBOX_CLIENT.cleanup();
}
