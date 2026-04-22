/**
 * Prepare Context Node — Inject browser state into agent prompt.
 *
 * Translated from: app/agent/browser.py BrowserContextHelper (lines 64-129)
 *                  app/agent/manus.py Manus.think() (lines 140-165)
 *
 * Behavior:
 * - Checks if browser_use was called in the last 3 messages
 * - If yes: captures screenshot + URL + tabs + interactive elements
 * - Injects as a multimodal HumanMessage (text + image)
 *
 * Used in: browser-enabled agent graphs (Manus, BrowserAgent)
 * Position: runs BEFORE the think node
 */
import { HumanMessage } from "@langchain/core/messages";
import type { AgentStateType } from "@/state/agentState";
import { browserManager } from "@/tools/browserUse";
import { logger } from "@/utils/logger";

const BROWSER_TOOL_NAME = "browser_use";
const RECENT_MESSAGES_CHECK = 3;

/**
 * Check if browser was used recently and inject context if so.
 *
 * Returns state update with browser context message, or empty object.
 */
export async function prepareContextNode(state: AgentStateType) {
  const recentMessages = state.messages.slice(-RECENT_MESSAGES_CHECK);

  // Check if any recent message has a browser_use tool call
  const browserUsed = recentMessages.some((msg) => {
    const toolCalls = (msg as any).tool_calls;
    return toolCalls?.some((tc: any) => tc.name === BROWSER_TOOL_NAME);
  });

  if (!browserUsed) return {};

  // Get current browser state
  const browserState = await browserManager.getState();
  if (!browserState) return {};

  logger.debug({ url: browserState.url }, "Injecting browser context");

  // Build multimodal message with screenshot + state info
  const stateText = [
    `Current URL: ${browserState.url}`,
    `Page Title: ${browserState.title}`,
    `Open Tabs: ${browserState.tabCount}`,
    "",
    "Interactive Elements:",
    browserState.interactiveElements || "(none detected)",
  ].join("\n");

  return {
    messages: [
      new HumanMessage({
        content: [
          { type: "text", text: `[Browser State]\n${stateText}` },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${browserState.screenshot}`,
            },
          },
        ],
      }),
    ],
    screenshot: browserState.screenshot,
  };
}
