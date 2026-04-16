/**
 * Sandbox Shell Tool — tmux-based persistent shell sessions in sandbox.
 *
 * Translated from: app/tool/sandbox/sb_shell_tool.py (419 lines)
 *
 * 4 actions:
 * - execute_command: Run command in tmux session (blocking or non-blocking)
 * - check_command_output: Read output from a running tmux session
 * - terminate_command: Kill a tmux session
 * - list_commands: List all active tmux sessions
 *
 * Key difference from bash.ts: tmux-based non-blocking execution,
 * multiple named sessions, process lifecycle management.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { SANDBOX_CLIENT } from "../../sandbox/docker.js";
import { logger } from "../../utils/logger.js";
import { randomUUID } from "crypto";

export const sandboxShell = tool(
  async ({
    action,
    command = "",
    folder = "",
    sessionName = "",
    blocking = false,
    timeout = 60,
    killSession = false,
  }): Promise<string> => {
    if (!SANDBOX_CLIENT.isReady) {
      return "Error: Sandbox not initialized. Create a sandbox first.";
    }

    const session = sessionName || `session_${randomUUID().slice(0, 8)}`;
    const workDir = folder ? `/workspace/${folder}` : "/workspace";

    switch (action) {
      case "execute_command": {
        if (!command) return "Error: command is required for execute_command";

        // Create tmux session and run command
        const tmuxCmd = blocking
          ? `cd ${workDir} && tmux new-session -d -s ${session} "${command}" && tmux wait-for ${session}`
          : `cd ${workDir} && tmux new-session -d -s ${session} "${command}"`;

        try {
          const result = await SANDBOX_CLIENT.runCommand(
            tmuxCmd,
            blocking ? timeout : 10
          );

          if (blocking) {
            // Get output after command completes
            const output = await SANDBOX_CLIENT.runCommand(
              `tmux capture-pane -t ${session} -p 2>/dev/null || echo "(session ended)"`,
              10
            );
            return `[${session}] ${output.stdout || "(no output)"}`;
          }
          return `Command started in session '${session}' (non-blocking). Use check_command_output to view results.`;
        } catch (e: any) {
          return `Error executing command: ${e.message}`;
        }
      }

      case "check_command_output": {
        if (!sessionName) return "Error: session_name is required for check_command_output";
        try {
          const output = await SANDBOX_CLIENT.runCommand(
            `tmux capture-pane -t ${sessionName} -p 2>/dev/null || echo "Session '${sessionName}' not found"`,
            10
          );
          let result = output.stdout || "(no output)";

          if (killSession) {
            await SANDBOX_CLIENT.runCommand(`tmux kill-session -t ${sessionName} 2>/dev/null`, 5);
            result += "\n(session terminated)";
          }
          return `[${sessionName}] ${result}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }

      case "terminate_command": {
        if (!sessionName) return "Error: session_name is required for terminate_command";
        try {
          await SANDBOX_CLIENT.runCommand(`tmux kill-session -t ${sessionName} 2>/dev/null`, 5);
          return `Session '${sessionName}' terminated.`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }

      case "list_commands": {
        try {
          const result = await SANDBOX_CLIENT.runCommand(
            `tmux list-sessions 2>/dev/null || echo "No active sessions"`,
            10
          );
          return `Active sessions:\n${result.stdout}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }

      default:
        return `Error: Unknown action '${action}'. Use: execute_command, check_command_output, terminate_command, list_commands`;
    }
  },
  {
    name: "sandbox_shell",
    description: `Execute shell commands in the sandbox workspace using tmux sessions.
Commands are non-blocking by default — ideal for servers and long tasks.
Actions: execute_command, check_command_output, terminate_command, list_commands.`,
    schema: z.object({
      action: z.enum(["execute_command", "check_command_output", "terminate_command", "list_commands"]),
      command: z.string().default("").describe("Shell command to execute."),
      folder: z.string().default("").describe("Relative subdirectory of /workspace."),
      sessionName: z.string().default("").describe("Named tmux session. Defaults to random."),
      blocking: z.boolean().default(false).describe("Wait for completion. Default: false."),
      timeout: z.number().default(60).describe("Timeout for blocking commands (seconds)."),
      killSession: z.boolean().default(false).describe("Terminate session after checking output."),
    }),
  }
);
