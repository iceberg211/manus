/**
 * Sandbox Terminal — Interactive persistent bash session inside Docker container.
 *
 * Translated from: app/sandbox/core/terminal.py (346 lines)
 *
 * Key behaviors preserved:
 * 1. Persistent bash session inside container (cd, env vars survive)
 * 2. Prompt detection ("$ ") for output boundary
 * 3. Command sanitization — blocks dangerous patterns
 * 4. Path traversal protection
 * 5. Non-blocking I/O with timeout
 *
 * Implementation approach:
 * Python uses Docker API socket-level I/O (docker-py exec_create + raw socket).
 * TS uses `docker exec -i` with stdin/stdout pipes (child_process.spawn).
 * This achieves the same persistent session effect without Docker API bindings.
 */
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 200;

// Command sanitization (from sb_shell_tool.py + IMPROVEMENTS.md S-2)
const DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+-(?:r|f|rf|fr)\s+\/(?:\s|$)/,
  /mkfs\b/,
  /dd\s+if=/,
  /:\(\)\{\s*:\|:\s*&\s*\}\s*;?\s*:/,
  /chmod\s+-R\s+777\s+\//,
  /chown\s+-R\s+.*\s+\//,
  />\s*\/dev\/sd/,
];

function sanitizeCommand(command: string): string | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return `Command blocked: matches dangerous pattern ${pattern.source}`;
    }
  }
  return null;
}

/**
 * Interactive bash session inside a Docker container.
 *
 * Maintains a persistent `docker exec -i` process with bash,
 * using UUID sentinels for output boundary detection.
 */
export class SandboxTerminal {
  private process: ChildProcess | null = null;
  private containerId: string;
  private workDir: string;
  private outputBuffer = "";
  private started = false;
  private timedOut = false;

  constructor(containerId: string, workDir = "/workspace") {
    this.containerId = containerId;
    this.workDir = workDir;
  }

  /** Start the persistent bash session inside the container. */
  async start(): Promise<void> {
    if (this.started) return;

    this.process = spawn("docker", [
      "exec", "-i",
      "-w", this.workDir,
      "-e", "TERM=dumb",
      "-e", "PS1=$ ",
      "-e", "PROMPT_COMMAND=",
      this.containerId,
      "/bin/bash", "--norc", "--noprofile",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      this.outputBuffer += data.toString();
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      this.outputBuffer += data.toString();
    });

    this.process.on("exit", (code) => {
      logger.debug({ code }, "Sandbox terminal exited");
      this.started = false;
    });

    this.started = true;

    // Wait for initial prompt
    await this._waitForOutput("$ ", 10_000);
    this.outputBuffer = "";
    logger.info({ containerId: this.containerId }, "Sandbox terminal started");
  }

  /** Execute a command and return its output. */
  async run(command: string, timeout = DEFAULT_TIMEOUT_MS): Promise<string> {
    if (!this.started || !this.process) {
      throw new Error("Terminal not started");
    }
    if (this.timedOut) {
      throw new Error("Terminal timed out and must be restarted");
    }
    if (this.process.exitCode !== null) {
      throw new Error(`Terminal process exited with code ${this.process.exitCode}`);
    }

    // Command sanitization
    const blocked = sanitizeCommand(command);
    if (blocked) return `Error: ${blocked}`;

    // Path traversal check for cd commands
    const cdMatch = command.match(/cd\s+(["']?)([^"';&|]+)\1/);
    if (cdMatch) {
      const target = cdMatch[2].trim();
      if (target.includes("..") && target.startsWith("/")) {
        return `Error: Path traversal detected in: ${command}`;
      }
    }

    // Random sentinel
    const sentinel = `__SENTINEL_${randomUUID().replace(/-/g, "")}__`;
    this.outputBuffer = "";

    this.process.stdin!.write(`${command}; echo '${sentinel}'\n`);

    // Wait for sentinel in output
    const output = await this._waitForOutput(sentinel, timeout);

    // Extract output before sentinel
    const idx = output.indexOf(sentinel);
    let result = idx >= 0 ? output.slice(0, idx) : output;
    if (result.endsWith("\n")) result = result.slice(0, -1);

    return result;
  }

  /** Wait for a marker string to appear in output buffer. */
  private _waitForOutput(marker: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.timedOut = true;
        reject(new Error(`Timeout waiting for output (${timeout}ms)`));
      }, timeout);

      const poll = setInterval(() => {
        if (this.outputBuffer.includes(marker)) {
          clearInterval(poll);
          clearTimeout(timer);
          const result = this.outputBuffer;
          this.outputBuffer = "";
          resolve(result);
        }
      }, POLL_INTERVAL_MS);
    });
  }

  /** Close the terminal session. */
  close(): void {
    if (this.process) {
      try {
        this.process.stdin?.write("exit\n");
      } catch { /* ignore */ }
      this.process.kill();
      this.process = null;
    }
    this.started = false;
    this.timedOut = false;
    this.outputBuffer = "";
  }

  /** Restart the terminal session. */
  async restart(): Promise<void> {
    this.close();
    await this.start();
  }

  get isStarted(): boolean {
    return this.started;
  }
}
