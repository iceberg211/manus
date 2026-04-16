/**
 * Sandbox Manager — Pool and lifecycle management for Docker sandboxes.
 *
 * Translated from: app/sandbox/core/manager.py (313 lines)
 *
 * Features:
 * 1. Sandbox pool with maxSandboxes limit
 * 2. Idle timeout tracking — auto-cleanup of unused sandboxes
 * 3. Background cleanup interval
 * 4. Per-sandbox concurrency locks
 * 5. Image pull/validation
 * 6. getStats() diagnostics
 */
import { DockerSandbox, type SandboxConfig } from "./docker.js";
import { SandboxTerminal } from "./terminal.js";
import { execSync } from "child_process";
import { logger } from "../utils/logger.js";

interface SandboxEntry {
  sandbox: DockerSandbox;
  terminal: SandboxTerminal | null;
  lastUsed: number;
  activeOps: number;
}

export interface SandboxManagerConfig {
  maxSandboxes?: number;
  idleTimeoutMs?: number;
  cleanupIntervalMs?: number;
}

export class SandboxManager {
  private sandboxes = new Map<string, SandboxEntry>();
  private config: Required<SandboxManagerConfig>;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private counter = 0;

  constructor(config: SandboxManagerConfig = {}) {
    this.config = {
      maxSandboxes: config.maxSandboxes ?? 5,
      idleTimeoutMs: config.idleTimeoutMs ?? 10 * 60 * 1000, // 10 minutes
      cleanupIntervalMs: config.cleanupIntervalMs ?? 60 * 1000, // 1 minute
    };
  }

  /** Ensure Docker image is available, pull if missing. */
  async ensureImage(image: string): Promise<void> {
    try {
      execSync(`docker image inspect ${image}`, { stdio: "pipe", timeout: 10000 });
    } catch {
      logger.info({ image }, "Pulling Docker image...");
      try {
        execSync(`docker pull ${image}`, { stdio: "pipe", timeout: 300000 });
        logger.info({ image }, "Image pulled successfully");
      } catch (e: any) {
        throw new Error(`Failed to pull image ${image}: ${e.message}`);
      }
    }
  }

  /** Create a new sandbox and register it in the pool. */
  async createSandbox(config?: SandboxConfig): Promise<string> {
    if (this.sandboxes.size >= this.config.maxSandboxes) {
      // Try to clean idle ones first
      await this.cleanupIdle();
      if (this.sandboxes.size >= this.config.maxSandboxes) {
        throw new Error(
          `Maximum sandbox limit reached (${this.config.maxSandboxes}). Delete idle sandboxes first.`
        );
      }
    }

    const sandbox = new DockerSandbox(config);
    await this.ensureImage(config?.image ?? "python:3.12-slim");
    const containerId = await sandbox.create();
    const id = `sandbox_${++this.counter}`;

    this.sandboxes.set(id, {
      sandbox,
      terminal: null,
      lastUsed: Date.now(),
      activeOps: 0,
    });

    logger.info({ id, containerId }, "Sandbox created");
    return id;
  }

  /** Get a sandbox by ID and track usage. */
  getSandbox(id: string): DockerSandbox | null {
    const entry = this.sandboxes.get(id);
    if (!entry) return null;
    entry.lastUsed = Date.now();
    return entry.sandbox;
  }

  /** Get or create a terminal for a sandbox. */
  async getTerminal(id: string): Promise<SandboxTerminal> {
    const entry = this.sandboxes.get(id);
    if (!entry) throw new Error(`Sandbox '${id}' not found`);

    if (!entry.terminal) {
      const containerId = entry.sandbox.id;
      if (!containerId) throw new Error(`Sandbox '${id}' has no container`);
      entry.terminal = new SandboxTerminal(containerId);
      await entry.terminal.start();
    }

    entry.lastUsed = Date.now();
    return entry.terminal;
  }

  /** Delete a specific sandbox. */
  async deleteSandbox(id: string): Promise<void> {
    const entry = this.sandboxes.get(id);
    if (!entry) return;

    // Wait briefly for active operations
    if (entry.activeOps > 0) {
      logger.warn({ id, activeOps: entry.activeOps }, "Waiting for active operations...");
      await new Promise((r) => setTimeout(r, 5000));
    }

    entry.terminal?.close();
    await entry.sandbox.cleanup();
    this.sandboxes.delete(id);
    logger.info({ id }, "Sandbox deleted");
  }

  /** Clean up sandboxes that have been idle too long. */
  async cleanupIdle(): Promise<number> {
    const now = Date.now();
    const idleIds: string[] = [];

    for (const [id, entry] of this.sandboxes) {
      if (
        entry.activeOps === 0 &&
        now - entry.lastUsed > this.config.idleTimeoutMs
      ) {
        idleIds.push(id);
      }
    }

    for (const id of idleIds) {
      await this.deleteSandbox(id);
    }

    if (idleIds.length > 0) {
      logger.info({ count: idleIds.length }, "Cleaned up idle sandboxes");
    }
    return idleIds.length;
  }

  /** Start background cleanup task. */
  startCleanupTask(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdle().catch((e) =>
        logger.error({ err: e }, "Cleanup task error")
      );
    }, this.config.cleanupIntervalMs);
    logger.debug("Sandbox cleanup task started");
  }

  /** Stop background cleanup task. */
  stopCleanupTask(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Clean up all sandboxes and stop background tasks. */
  async shutdown(): Promise<void> {
    this.stopCleanupTask();
    const ids = [...this.sandboxes.keys()];
    await Promise.all(ids.map((id) => this.deleteSandbox(id)));
    logger.info("Sandbox manager shut down");
  }

  /** Get diagnostic stats. */
  getStats(): {
    total: number;
    maxSandboxes: number;
    idle: number;
    active: number;
  } {
    const now = Date.now();
    let idle = 0;
    let active = 0;

    for (const entry of this.sandboxes.values()) {
      if (entry.activeOps > 0) active++;
      else if (now - entry.lastUsed > this.config.idleTimeoutMs) idle++;
    }

    return {
      total: this.sandboxes.size,
      maxSandboxes: this.config.maxSandboxes,
      idle,
      active,
    };
  }
}
