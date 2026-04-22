/**
 * Sandbox Files Tool — File operations within sandbox with path boundary.
 *
 * Translated from: app/tool/sandbox/sb_files_tool.py (361 lines)
 *
 * Operations: read, write, list, search, mkdir, delete
 * Path boundary: all operations restricted to /workspace
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { SANDBOX_CLIENT } from "@/sandbox/docker";
import { resolve, posix } from "path";

const WORKSPACE = "/workspace";

function validatePath(path: string): string | null {
  // Normalize and check within workspace
  const normalized = posix.resolve(WORKSPACE, path);
  if (!normalized.startsWith(WORKSPACE)) {
    return `Path '${path}' is outside workspace boundary '${WORKSPACE}'`;
  }
  return null;
}

export const sandboxFiles = tool(
  async ({ action, path, content, pattern }): Promise<string> => {
    if (!SANDBOX_CLIENT.isReady) {
      return "Error: Sandbox not initialized.";
    }

    // Resolve path relative to workspace
    const fullPath = path.startsWith("/") ? path : posix.join(WORKSPACE, path);
    const pathErr = validatePath(fullPath);
    if (pathErr) return `Error: ${pathErr}`;

    switch (action) {
      case "read": {
        try {
          return await SANDBOX_CLIENT.readFile(fullPath);
        } catch (e: any) {
          return `Error reading ${fullPath}: ${e.message}`;
        }
      }

      case "write": {
        if (!content) return "Error: content is required for write action";
        try {
          await SANDBOX_CLIENT.writeFile(fullPath, content);
          return `File written to ${fullPath}`;
        } catch (e: any) {
          return `Error writing ${fullPath}: ${e.message}`;
        }
      }

      case "list": {
        try {
          const result = await SANDBOX_CLIENT.runCommand(
            `find "${fullPath}" -maxdepth 2 -not -path '*/\\.*' 2>/dev/null`,
            10
          );
          return result.stdout || `No files found in ${fullPath}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }

      case "search": {
        if (!pattern) return "Error: pattern is required for search action";
        try {
          const result = await SANDBOX_CLIENT.runCommand(
            `grep -rn "${pattern}" "${fullPath}" --include="*.py" --include="*.ts" --include="*.js" --include="*.json" --include="*.md" --include="*.txt" 2>/dev/null | head -50`,
            15
          );
          return result.stdout || `No matches for '${pattern}' in ${fullPath}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }

      case "mkdir": {
        try {
          await SANDBOX_CLIENT.runCommand(`mkdir -p "${fullPath}"`, 5);
          return `Directory created: ${fullPath}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }

      case "delete": {
        // Extra safety: prevent deleting workspace root
        if (fullPath === WORKSPACE || fullPath === WORKSPACE + "/") {
          return "Error: Cannot delete workspace root";
        }
        try {
          await SANDBOX_CLIENT.runCommand(`rm -rf "${fullPath}"`, 10);
          return `Deleted: ${fullPath}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      }

      default:
        return `Error: Unknown action '${action}'`;
    }
  },
  {
    name: "sandbox_files",
    description: `File operations within the sandbox workspace.
All paths are relative to /workspace (or absolute within /workspace).
Actions: read, write, list, search, mkdir, delete.`,
    schema: z.object({
      action: z.enum(["read", "write", "list", "search", "mkdir", "delete"]),
      path: z.string().describe("File/directory path (relative to /workspace or absolute)."),
      content: z.string().default("").describe("Content for write action."),
      pattern: z.string().default("").describe("Search pattern for search action."),
    }),
  }
);
