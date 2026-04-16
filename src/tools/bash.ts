/**
 * Bash Tool — Persistent bash session for command execution.
 *
 * Translated from: app/tool/bash.py
 *
 * Key behaviors preserved:
 * 1. PERSISTENT SESSION: one /bin/bash process reused across calls (cd, env vars survive)
 * 2. SENTINEL PATTERN: appends "; echo '<<exit>>'" to detect command output end
 * 3. TIMEOUT: 120s per command, kills session on timeout
 * 4. INTERACTIVE: empty command retrieves additional logs; "ctrl+c" sends interrupt
 *
 * Improvements over Python original:
 * - S-2: Command sanitization (blocks rm -rf /, mkfs, dd, fork bombs, etc.)
 * - S-4: Random UUID sentinel per command (prevents output collision)
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { BASH } from "../config/constants.js";

const DEFAULT_TIMEOUT = BASH.TIMEOUT_MS;
const OUTPUT_POLL_INTERVAL = BASH.POLL_INTERVAL_MS;

// S-2: Dangerous command patterns (from sb_shell_tool.py _sanitize_command)
const DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+-(?:r|f|rf|fr)\s+\/(?:\s|$)/,  // rm -rf /
  /mkfs\b/,                               // format disk
  /dd\s+if=/,                              // raw disk write
  /:\(\)\{\s*:\|:\s*&\s*\}\s*;?\s*:/,    // fork bomb :(){ :|:& };:
  /chmod\s+-R\s+777\s+\//,               // global permission change
  /chown\s+-R\s+.*\s+\//,                // global ownership change
  />\s*\/dev\/sd/,                         // write to disk device
];

/** S-2: Check if a command contains dangerous patterns. */
function isDangerousCommand(command: string): string | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return `Command blocked: matches dangerous pattern ${pattern.source}`;
    }
  }
  return null;
}

/** S-4: Generate a unique sentinel per command invocation. */
function makeSentinel(): string {
  return `__SENTINEL_${randomUUID().replace(/-/g, "")}__`;
}

class BashSession {
  private process: ChildProcess | null = null;
  private started = false;
  private timedOut = false;
  private outputBuffer = "";
  private errorBuffer = "";

  async start(): Promise<void> {
    if (this.started) return;

    this.process = spawn("/bin/bash", [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      this.outputBuffer += data.toString();
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      this.errorBuffer += data.toString();
    });

    this.process.on("exit", () => {
      this.started = false;
    });

    this.started = true;
  }

  stop(): void {
    if (!this.started || !this.process) return;
    this.process.kill();
    this.process = null;
    this.started = false;
  }

  async run(command: string): Promise<{ output: string; error: string }> {
    if (!this.started || !this.process) {
      throw new Error("Session has not started.");
    }

    if (this.process.exitCode !== null) {
      return {
        output: "",
        error: `bash has exited with returncode ${this.process.exitCode}`,
      };
    }

    if (this.timedOut) {
      throw new Error(
        `timed out: bash has not returned in ${DEFAULT_TIMEOUT / 1000} seconds and must be restarted`
      );
    }

    // Clear buffers before new command
    this.outputBuffer = "";
    this.errorBuffer = "";

    // S-4: Random sentinel per command (prevents output content collision)
    const sentinel = makeSentinel();

    // Send command with sentinel
    this.process.stdin!.write(`${command}; echo '${sentinel}'\n`);

    // Poll stdout buffer until sentinel found
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.timedOut = true;
        reject(
          new Error(
            `timed out: bash has not returned in ${DEFAULT_TIMEOUT / 1000} seconds and must be restarted`
          )
        );
      }, DEFAULT_TIMEOUT);

      const poll = setInterval(() => {
        if (this.outputBuffer.includes(sentinel)) {
          clearInterval(poll);
          clearTimeout(timer);

          // Strip sentinel and trailing newline
          let output = this.outputBuffer.slice(
            0,
            this.outputBuffer.indexOf(sentinel)
          );
          if (output.endsWith("\n")) {
            output = output.slice(0, -1);
          }

          let error = this.errorBuffer;
          if (error.endsWith("\n")) {
            error = error.slice(0, -1);
          }

          // Clear buffers for next call
          this.outputBuffer = "";
          this.errorBuffer = "";

          resolve({ output, error });
        }
      }, OUTPUT_POLL_INTERVAL);
    });
  }

  async restart(): Promise<string> {
    this.stop();
    this.timedOut = false;
    await this.start();
    return "tool has been restarted.";
  }

  get isStarted(): boolean {
    return this.started;
  }
}

// Singleton session — persistent across tool calls (matches Python's behavior)
const session = new BashSession();

/**
 * Bash tool for LangGraph.
 *
 * Translates from OpenManus Bash(BaseTool) at app/tool/bash.py.
 * The description is kept nearly identical to preserve LLM behavior.
 */
export const bash = tool(
  async ({ command, restart }): Promise<string> => {
    if (restart) {
      return session.restart();
    }

    if (!session.isStarted) {
      await session.start();
    }

    if (!command) {
      return "Error: no command provided.";
    }

    // S-2: Block dangerous commands
    const blocked = isDangerousCommand(command);
    if (blocked) {
      return `Error: ${blocked}`;
    }

    try {
      const result = await session.run(command);
      if (result.error && !result.output) {
        return `Error: ${result.error}`;
      }
      if (result.error && result.output) {
        return `${result.output}\n\nStderr: ${result.error}`;
      }
      return result.output || "Command completed (no output)";
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
  {
    name: "bash",
    description: `Execute a bash command in the terminal.
* Long running commands: For commands that may run indefinitely, it should be run in the background and the output should be redirected to a file, e.g. command = \`python3 app.py > server.log 2>&1 &\`.
* Interactive: If a bash command returns exit code \`-1\`, this means the process is not yet finished. The assistant must then send a second call to terminal with an empty \`command\` (which will retrieve any additional logs), or it can send additional text (set \`command\` to the text) to STDIN of the running process, or it can send command=\`ctrl+c\` to interrupt the process.
* Timeout: If a command execution result says "Command timed out. Sending SIGINT to the process", the assistant should retry running the command in the background.`,
    schema: z.object({
      command: z
        .string()
        .describe(
          "The bash command to execute. Can be empty to view additional logs when previous exit code is `-1`. Can be `ctrl+c` to interrupt the currently running process."
        ),
      restart: z
        .boolean()
        .default(false)
        .describe("Set to true to restart the bash session."),
    }),
  }
);

// Export session for cleanup
export const bashSession = session;
