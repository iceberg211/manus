/**
 * File Operators — Abstraction layer for local vs sandbox file operations.
 *
 * Translated from: app/tool/file_operators.py (159 lines)
 *
 * Provides a common interface so strReplaceEditor and other file-touching tools
 * can work identically in local and sandbox environments.
 *
 * Improvement S-3: Path boundary check — all file operations validate that
 * the target path is within the configured workspace root.
 */
import { readFile, writeFile, stat, access, realpath } from "fs/promises";
import { resolve, dirname, basename, join } from "path";
import { execSync } from "child_process";
import { SANDBOX_CLIENT } from "../sandbox/docker.js";
import { getConfig, WORKSPACE_ROOT } from "../config/index.js";

// ---------------------------------------------------------------------------
// Interface (matches Python's FileOperator Protocol)
// ---------------------------------------------------------------------------

export interface FileOperator {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  isDirectory(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  runCommand(
    cmd: string,
    timeout?: number,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

// ---------------------------------------------------------------------------
// S-3: Path boundary check
// ---------------------------------------------------------------------------

/**
 * Resolve a path following symlinks as far as possible.
 *
 * For paths that don't exist yet (e.g., a file we're about to create), we walk
 * up ancestors until we find one that does exist, realpath() that, then
 * re-attach the remaining tail. This means a symlink anywhere in the ancestry
 * is followed, closing the "workspace/link → /etc" escape.
 */
async function resolveRealPath(targetPath: string): Promise<string> {
  const abs = resolve(targetPath);
  try {
    return await realpath(abs);
  } catch {
    // Path (or a leaf) doesn't exist — walk up to find a real ancestor.
    let current = abs;
    const tail: string[] = [];
    while (true) {
      const parent = dirname(current);
      if (parent === current) return abs; // reached root, nothing resolvable
      tail.unshift(basename(current));
      try {
        const realParent = await realpath(parent);
        return join(realParent, ...tail);
      } catch {
        current = parent;
      }
    }
  }
}

function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  // Use OS separator-aware boundary to avoid `/workspace_evil` passing `/workspace`.
  const sep = parent.endsWith("/") ? "" : "/";
  return child.startsWith(parent + sep);
}

/**
 * Validate that a path is within the allowed workspace boundary.
 * Prevents path traversal attacks (e.g., editing /etc/passwd) and symlink
 * escapes (a workspace symlink pointing at /etc would otherwise pass).
 *
 * @param targetPath - The path to validate (must be absolute)
 * @param workspace - The allowed root directory
 * @returns null if valid, error message if invalid
 */
export async function checkPathBoundary(
  targetPath: string,
  workspace?: string,
): Promise<string | null> {
  const root = workspace ?? WORKSPACE_ROOT;

  const resolvedTarget = await resolveRealPath(targetPath);
  const resolvedRoot = await resolveRealPath(root);
  const resolvedCwd = await resolveRealPath(process.cwd());
  const resolvedTmp = await resolveRealPath("/tmp");

  if (isWithin(resolvedTarget, resolvedRoot)) return null;
  if (isWithin(resolvedTarget, resolvedCwd)) return null;
  if (isWithin(resolvedTarget, resolvedTmp)) return null;

  return `Path '${targetPath}' is outside the allowed workspace '${root}'. For security, file operations are restricted to the workspace directory.`;
}

// ---------------------------------------------------------------------------
// Local implementation
// ---------------------------------------------------------------------------

export class LocalFileOperator implements FileOperator {
  private encoding: BufferEncoding = "utf-8";

  async readFile(path: string): Promise<string> {
    return readFile(path, { encoding: this.encoding });
  }

  async writeFile(path: string, content: string): Promise<void> {
    await writeFile(path, content, { encoding: this.encoding });
  }

  async isDirectory(path: string): Promise<boolean> {
    try {
      const s = await stat(path);
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async runCommand(
    cmd: string,
    timeout = 120,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const stdout = execSync(cmd, {
        encoding: "utf-8",
        timeout: timeout * 1000,
        maxBuffer: 1024 * 1024,
      });
      return { code: 0, stdout, stderr: "" };
    } catch (e: any) {
      return {
        code: e.status ?? 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Sandbox implementation
// ---------------------------------------------------------------------------

export class SandboxFileOperator implements FileOperator {
  private async ensureSandbox() {
    if (!SANDBOX_CLIENT.isReady) {
      await SANDBOX_CLIENT.create();
    }
  }

  async readFile(path: string): Promise<string> {
    await this.ensureSandbox();
    return SANDBOX_CLIENT.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.ensureSandbox();
    await SANDBOX_CLIENT.writeFile(path, content);
  }

  async isDirectory(path: string): Promise<boolean> {
    await this.ensureSandbox();
    const result = await SANDBOX_CLIENT.runCommand(
      `test -d "${path}" && echo 'true' || echo 'false'`,
    );
    return result.stdout.trim() === "true";
  }

  async exists(path: string): Promise<boolean> {
    await this.ensureSandbox();
    const result = await SANDBOX_CLIENT.runCommand(
      `test -e "${path}" && echo 'true' || echo 'false'`,
    );
    return result.stdout.trim() === "true";
  }

  async runCommand(
    cmd: string,
    timeout = 120,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    await this.ensureSandbox();
    const result = await SANDBOX_CLIENT.runCommand(cmd, timeout);
    return {
      code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const localOperator = new LocalFileOperator();
const sandboxOperator = new SandboxFileOperator();

/**
 * Get the appropriate file operator based on config.
 * Matches Python's `_get_operator()` pattern in str_replace_editor.py.
 */
export function getOperator(): FileOperator {
  const config = getConfig();
  return config.sandbox.use_sandbox ? sandboxOperator : localOperator;
}
