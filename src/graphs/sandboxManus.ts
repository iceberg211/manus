/**
 * SandboxManus Agent — Agent variant running in Docker sandbox.
 * Translated from: app/agent/sandbox_agent.py
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { buildReactAgent } from "@/graphs/reactAgent";
import { createLLM } from "@/config/llmFactory";
import { sandboxShell } from "@/tools/sandbox/sbShellTool";
import { sandboxFiles } from "@/tools/sandbox/sbFilesTool";
import { sandboxBrowser } from "@/tools/sandbox/sbBrowserTool";
import { sandboxVision } from "@/tools/sandbox/sbVisionTool";
import { MANUS_SYSTEM_PROMPT, MANUS_NEXT_STEP_PROMPT } from "@/prompts/manus";
import { SANDBOX_CLIENT } from "@/sandbox/docker";
import { logger } from "@/utils/logger";

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
