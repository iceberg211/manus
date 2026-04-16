/**
 * Code Execute Tool — Executes Python code in a subprocess.
 *
 * Translated from: app/tool/python_execute.py
 *
 * Key behaviors preserved:
 * 1. Only print() output is captured (not return values)
 * 2. Timeout: default 5 seconds, kills process
 * 3. Uses child_process to spawn python3 (OpenManus used multiprocessing.Process)
 * 4. Code written to temp file → executed → stdout captured → temp file cleaned up
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export const codeExecute = tool(
  async ({ code, timeout = 5 }): Promise<string> => {
    const tmpFile = join(
      tmpdir(),
      `openmanus_exec_${Date.now()}_${Math.random().toString(36).slice(2)}.py`,
    );

    try {
      writeFileSync(tmpFile, code, "utf-8");

      const result = execSync(`python3 "${tmpFile}"`, {
        timeout: timeout * 1000,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024, // 1MB output buffer
        stdio: ["pipe", "pipe", "pipe"],
      });

      return result || "Code executed successfully (no output)";
    } catch (e: unknown) {
      const errObj = e as any;
      // Timeout detection: killed flag or ETIMEDOUT in message
      if (errObj?.killed || errObj?.message?.includes("ETIMEDOUT")) {
        return `Execution timeout after ${timeout} seconds`;
      }
      if (errObj?.stderr) {
        return `Error: ${errObj.stderr}`;
      }
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  },
  {
    name: "code_execute",
    description:
      "Executes Python code string. Note: Only print outputs are visible, function return values are not captured. Use print statements to see results.",
    schema: z.object({
      code: z.string().describe("The Python code to execute."),
      timeout: z
        .number()
        .default(5)
        .describe("Execution timeout in seconds. Default is 5."),
    }),
  },
);
