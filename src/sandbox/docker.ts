/**
 * Docker Sandbox — Container-based isolated execution environment.
 *
 * Translated from: app/sandbox/core/sandbox.py (462 lines)
 *                  app/sandbox/core/terminal.py (346 lines)
 *                  app/sandbox/core/manager.py (313 lines)
 *                  app/sandbox/client.py
 *
 * Key behaviors preserved:
 * 1. Docker container lifecycle (create, start, stop, cleanup)
 * 2. Resource limits (memory, CPU)
 * 3. Volume bindings (host ↔ container file sync)
 * 4. Command execution with timeout
 * 5. File copy to/from container
 * 6. Singleton client pattern
 *
 * Requires: Docker daemon running and `docker` CLI available.
 */
import { execSync } from "child_process";
import { SANDBOX } from "@/config/constants";

export interface SandboxConfig {
  image?: string;
  workDir?: string;
  memoryLimit?: string;
  cpuLimit?: number;
  timeout?: number;
  networkEnabled?: boolean;
  volumes?: Record<string, string>; // host:container
}

export class DockerSandbox {
  private containerId: string | null = null;
  private config: Required<SandboxConfig>;

  constructor(config: SandboxConfig = {}) {
    this.config = {
      image: config.image ?? SANDBOX.DEFAULT_IMAGE,
      workDir: config.workDir ?? SANDBOX.WORK_DIR,
      memoryLimit: config.memoryLimit ?? SANDBOX.MEMORY_LIMIT,
      cpuLimit: config.cpuLimit ?? SANDBOX.CPU_LIMIT,
      timeout: config.timeout ?? SANDBOX.TIMEOUT_SEC,
      networkEnabled: config.networkEnabled ?? false,
      volumes: config.volumes ?? {},
    };
  }

  /** Create and start a Docker container. */
  async create(): Promise<string> {
    const args = [
      "docker",
      "run",
      "-d",
      "--rm",
      `-w`, this.config.workDir,
      `-m`, this.config.memoryLimit,
      `--cpus=${this.config.cpuLimit}`,
    ];

    if (!this.config.networkEnabled) {
      args.push("--network=none");
    }

    // Volume bindings
    for (const [host, container] of Object.entries(this.config.volumes)) {
      args.push("-v", `${host}:${container}`);
    }

    // Keep container alive with sleep
    args.push(this.config.image, "sleep", "infinity");

    try {
      const result = execSync(args.join(" "), { encoding: "utf-8", timeout: 30000 });
      this.containerId = result.trim();
      return this.containerId;
    } catch (e: any) {
      throw new Error(`Failed to create sandbox: ${e.stderr ?? e.message}`);
    }
  }

  /** Execute a command inside the container. */
  async runCommand(
    command: string,
    timeout?: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!this.containerId) throw new Error("Sandbox not created");

    const timeoutMs = (timeout ?? this.config.timeout) * 1000;

    try {
      const stdout = execSync(
        `docker exec ${this.containerId} /bin/bash -c ${JSON.stringify(command)}`,
        {
          encoding: "utf-8",
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
        }
      );
      return { stdout, stderr: "", exitCode: 0 };
    } catch (e: any) {
      if (e.killed) {
        return {
          stdout: "",
          stderr: `Command timed out after ${timeout ?? this.config.timeout}s`,
          exitCode: 124,
        };
      }
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message,
        exitCode: e.status ?? 1,
      };
    }
  }

  /** Copy a file from host to container. */
  async copyTo(hostPath: string, containerPath: string): Promise<void> {
    if (!this.containerId) throw new Error("Sandbox not created");
    execSync(
      `docker cp "${hostPath}" ${this.containerId}:${containerPath}`,
      { timeout: 30000 }
    );
  }

  /** Copy a file from container to host. */
  async copyFrom(containerPath: string, hostPath: string): Promise<void> {
    if (!this.containerId) throw new Error("Sandbox not created");
    execSync(
      `docker cp ${this.containerId}:${containerPath} "${hostPath}"`,
      { timeout: 30000 }
    );
  }

  /** Write content to a file inside the container. */
  async writeFile(containerPath: string, content: string): Promise<void> {
    if (!this.containerId) throw new Error("Sandbox not created");
    // Use base64 to avoid escaping issues
    const b64 = Buffer.from(content).toString("base64");
    execSync(
      `docker exec ${this.containerId} /bin/bash -c "echo '${b64}' | base64 -d > ${containerPath}"`,
      { timeout: 10000 }
    );
  }

  /** Read content from a file inside the container. */
  async readFile(containerPath: string): Promise<string> {
    if (!this.containerId) throw new Error("Sandbox not created");
    return execSync(
      `docker exec ${this.containerId} cat ${containerPath}`,
      { encoding: "utf-8", timeout: 10000 }
    );
  }

  /** Stop and remove the container. */
  async cleanup(): Promise<void> {
    if (!this.containerId) return;
    try {
      execSync(`docker kill ${this.containerId}`, { timeout: 10000 });
    } catch {
      // Container may already be stopped
    }
    this.containerId = null;
  }

  get isRunning(): boolean {
    return this.containerId !== null;
  }

  get id(): string | null {
    return this.containerId;
  }
}

/**
 * Singleton sandbox client (matches SANDBOX_CLIENT from Python).
 *
 * Provides a single shared sandbox instance.
 * Call create() before use, cleanup() when done.
 */
class SandboxClient {
  private sandbox: DockerSandbox | null = null;

  async create(config?: SandboxConfig): Promise<DockerSandbox> {
    if (this.sandbox?.isRunning) return this.sandbox;
    this.sandbox = new DockerSandbox(config);
    await this.sandbox.create();
    return this.sandbox;
  }

  async runCommand(command: string, timeout?: number) {
    if (!this.sandbox) throw new Error("Sandbox not initialized. Call create() first.");
    return this.sandbox.runCommand(command, timeout);
  }

  async writeFile(path: string, content: string) {
    if (!this.sandbox) throw new Error("Sandbox not initialized");
    return this.sandbox.writeFile(path, content);
  }

  async readFile(path: string) {
    if (!this.sandbox) throw new Error("Sandbox not initialized");
    return this.sandbox.readFile(path);
  }

  async cleanup() {
    if (this.sandbox) {
      await this.sandbox.cleanup();
      this.sandbox = null;
    }
  }

  get isReady(): boolean {
    return this.sandbox?.isRunning ?? false;
  }
}

/** Global singleton sandbox client. */
export const SANDBOX_CLIENT = new SandboxClient();
