/**
 * Sandbox Vision Tool — Screenshot and OCR analysis in sandbox.
 *
 * Translated from: app/tool/sandbox/sb_vision_tool.py (178 lines)
 *
 * Takes screenshots of the sandbox screen (via VNC or Xvfb) and
 * can perform OCR/image analysis.
 *
 * For the initial implementation, captures terminal output as text
 * and uses basic screen capture if Xvfb is available.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { SANDBOX_CLIENT } from "@/sandbox/docker";

export const sandboxVision = tool(
  async ({ action, screenshotPath }): Promise<string> => {
    if (!SANDBOX_CLIENT.isReady) {
      return "Error: Sandbox not initialized.";
    }

    switch (action) {
      case "screenshot": {
        const outPath = screenshotPath || "/workspace/screenshot.png";
        try {
          // Try Xvfb-based screenshot (requires xdotool/scrot/import in sandbox)
          const result = await SANDBOX_CLIENT.runCommand(
            `if command -v import &>/dev/null; then import -window root "${outPath}" && echo "saved"; elif command -v scrot &>/dev/null; then scrot "${outPath}" && echo "saved"; else echo "no_screenshot_tool"; fi`,
            10
          );
          if (result.stdout.trim() === "saved") {
            return `Screenshot saved to ${outPath}`;
          }
          // Fallback: capture terminal state
          const termResult = await SANDBOX_CLIENT.runCommand(
            `tmux capture-pane -p 2>/dev/null || echo "(no tmux session)"`,
            5
          );
          return `Screenshot tools not available. Terminal state:\n${termResult.stdout}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }

      case "read_screen": {
        // Read current terminal/screen content
        try {
          const result = await SANDBOX_CLIENT.runCommand(
            `tmux list-sessions -F "#{session_name}" 2>/dev/null | while read s; do echo "=== $s ==="; tmux capture-pane -t "$s" -p; done || echo "No active sessions"`,
            10
          );
          return `Screen content:\n${result.stdout}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }

      case "ocr": {
        // Basic OCR if tesseract is available
        const imgPath = screenshotPath || "/workspace/screenshot.png";
        try {
          const result = await SANDBOX_CLIENT.runCommand(
            `if command -v tesseract &>/dev/null; then tesseract "${imgPath}" stdout 2>/dev/null; else echo "OCR not available. Install tesseract: apt install tesseract-ocr"; fi`,
            30
          );
          return `OCR result:\n${result.stdout}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }

      default:
        return `Error: Unknown action '${action}'. Available: screenshot, read_screen, ocr.`;
    }
  },
  {
    name: "sandbox_vision",
    description: `Screen capture and OCR analysis within the sandbox.
Actions:
- screenshot: Capture screen to file (requires Xvfb + scrot/import in sandbox)
- read_screen: Read current terminal/tmux content as text
- ocr: Extract text from screenshot image (requires tesseract in sandbox)`,
    schema: z.object({
      action: z.enum(["screenshot", "read_screen", "ocr"]),
      screenshotPath: z.string().default("").describe("Path for screenshot file. Default: /workspace/screenshot.png"),
    }),
  }
);
