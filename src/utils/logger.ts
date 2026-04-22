/**
 * Logger — Structured logging with pino.
 *
 * Translated from: app/logger.py (loguru) + app/utils/logger.py (structlog)
 *
 * Features:
 * - Global singleton: `import { logger } from "@/utils/logger"`
 * - Levels: debug/info/warn/error/fatal
 * - File output: logs/{timestamp}.log (when LOG_FILE=true)
 * - JSON mode: NODE_ENV=production → structured JSON output
 * - Pretty mode: development → colorized human-readable output
 */
import pino from "pino";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";

const isProd = process.env.NODE_ENV === "production";
const enableFileLog = process.env.LOG_FILE === "true";
const logLevel = process.env.LOG_LEVEL ?? (isProd ? "info" : "debug");

// Ensure logs directory exists if file logging is enabled
const logsDir = join(process.cwd(), "logs");
if (enableFileLog && !existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true });
}

// Build transport targets
const targets: pino.TransportTargetOptions[] = [];

if (isProd) {
  // Production: JSON to stdout
  targets.push({ target: "pino/file", options: { destination: 1 }, level: logLevel as string });
} else {
  // Development: pretty-printed to stdout
  targets.push({
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
    },
    level: logLevel as string,
  });
}

if (enableFileLog) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(logsDir, `${timestamp}.log`);
  targets.push({
    target: "pino/file",
    options: { destination: logFile },
    level: "debug",
  });
}

/**
 * Global logger instance.
 *
 * Usage:
 * ```ts
 * import { logger } from "@/utils/logger";
 * logger.info("Agent started");
 * logger.debug({ tools: ["bash", "code"] }, "Tools loaded");
 * logger.error({ err }, "Failed to execute tool");
 * ```
 */
export const logger = pino({
  level: logLevel,
  transport: targets.length > 0 ? { targets } : undefined,
});
