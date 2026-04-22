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
import { readFile, writeFile, stat, access, realpath, readdir, unlink } from "fs/promises";
import { resolve, dirname, basename, join, relative } from "path";
import { execSync } from "child_process";
import { SANDBOX_CLIENT } from "../sandbox/docker.js";
import { getConfig, WORKSPACE_ROOT } from "../config/index.js";

// ---------------------------------------------------------------------------
// Shell quoting helpers (S-5)
// ---------------------------------------------------------------------------

/**
 * Quote a string safely for use as a single POSIX shell argument.
 * Wraps in single quotes and escapes existing single quotes using the
 * classic `'\''` pattern. Prevents command injection via filenames that
 * contain quotes, `$`, backticks, newlines, etc.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Interface (matches Python's FileOperator Protocol)
// ---------------------------------------------------------------------------

export interface FileOperator {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  isDirectory(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  /**
   * List directory entries up to `maxDepth` levels deep, excluding hidden
   * (dotfile) entries. Returns absolute paths, one per line — compatible
   * with the previous `find`-based viewer output.
   */
  listDirectory(path: string, maxDepth?: number): Promise<string[]>;
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

  async deleteFile(path: string): Promise<void> {
    await unlink(path);
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

  async listDirectory(path: string, maxDepth = 2): Promise<string[]> {
    // S-5: 纯 fs API，不 shell out 到 `find`，避免文件名注入
    const results: string[] = [];

    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > maxDepth) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        // Skip hidden dotfiles (matches `-not -path '*/.*'` semantics)
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        results.push(full);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        }
      }
    }

    results.push(path);
    await walk(path, 1);
    return results;
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

  async deleteFile(path: string): Promise<void> {
    await this.ensureSandbox();
    await SANDBOX_CLIENT.runCommand(`rm -f ${shellQuote(path)}`);
  }

  async isDirectory(path: string): Promise<boolean> {
    await this.ensureSandbox();
    // S-5: shellQuote prevents injection via filenames containing quotes/$/newlines
    const result = await SANDBOX_CLIENT.runCommand(
      `test -d ${shellQuote(path)} && echo 'true' || echo 'false'`,
    );
    return result.stdout.trim() === "true";
  }

  async exists(path: string): Promise<boolean> {
    await this.ensureSandbox();
    const result = await SANDBOX_CLIENT.runCommand(
      `test -e ${shellQuote(path)} && echo 'true' || echo 'false'`,
    );
    return result.stdout.trim() === "true";
  }

  async listDirectory(path: string, maxDepth = 2): Promise<string[]> {
    await this.ensureSandbox();
    // S-5: 所有动态值都 shellQuote；数字参数受 schema 限制不需要 quote
    const cmd = `find ${shellQuote(path)} -maxdepth ${Math.max(1, Math.floor(maxDepth))} -not -path '*/\\.*'`;
    const result = await SANDBOX_CLIENT.runCommand(cmd);
    return result.stdout.split("\n").filter((l) => l.length > 0);
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
