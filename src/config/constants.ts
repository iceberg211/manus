/**
 * Centralized Constants — All magic numbers and thresholds.
 *
 * Consolidated from scattered constants across tool files and nodes.
 * Matches values from the original OpenManus Python codebase.
 *
 * Usage: import { AGENT, TOOLS, SEARCH, SANDBOX } from "@/config/constants";
 */

// ---------------------------------------------------------------------------
// Agent behavior
// ---------------------------------------------------------------------------
export const AGENT = {
  /** Max tool output chars before truncation (Manus.max_observe). */
  MAX_OBSERVE: 10000,
  /** Max tool output for data analysis agent. */
  MAX_OBSERVE_DATA: 15000,
  /** Default recursion limit (max_steps * 2 because think+act = 2 iterations). */
  RECURSION_LIMIT: 50,
  /** Consecutive identical AI messages before stuck detection triggers. */
  DUPLICATE_THRESHOLD: 2,
  /** Prompt injected when agent is stuck. */
  UNSTUCK_PROMPT:
    "Observed duplicate responses. Consider new strategies and avoid repeating ineffective paths already attempted.",
} as const;

// ---------------------------------------------------------------------------
// Bash tool
// ---------------------------------------------------------------------------
export const BASH = {
  /** Sentinel string to detect command output end. */
  SENTINEL: "<<exit>>",
  /** Default command timeout in ms. */
  TIMEOUT_MS: 120_000,
  /** Polling interval for output buffer in ms. */
  POLL_INTERVAL_MS: 200,
} as const;

// ---------------------------------------------------------------------------
// Code execution
// ---------------------------------------------------------------------------
export const CODE_EXEC = {
  /** Default timeout for Python code execution in seconds. */
  TIMEOUT_SEC: 5,
  /** Max stdout buffer size in bytes. */
  MAX_BUFFER: 1024 * 1024, // 1MB
} as const;

// ---------------------------------------------------------------------------
// File editor
// ---------------------------------------------------------------------------
export const EDITOR = {
  /** Lines of context shown around edits in snippets. */
  SNIPPET_LINES: 4,
  /** Max output length before truncation. */
  MAX_RESPONSE_LEN: 16000,
  /** Message appended when output is truncated. */
  TRUNCATED_MESSAGE:
    '<response clipped><NOTE>To save on context only part of this file has been shown to you. ' +
    'You should retry this tool after you have searched inside the file with `grep -n` ' +
    'in order to find the line numbers of what you are looking for.</NOTE>',
} as const;

// ---------------------------------------------------------------------------
// Web search
// ---------------------------------------------------------------------------
export const SEARCH = {
  /** Max content length when fetching page content. */
  MAX_CONTENT_LENGTH: 10000,
  /** Max retries when all engines fail. */
  MAX_RETRIES: 3,
  /** Delay between full retry cycles in ms. */
  RETRY_DELAY_MS: 5000,
  /** Per-engine retry attempts. */
  ENGINE_MAX_ATTEMPTS: 3,
  /** Default search results count. */
  DEFAULT_NUM_RESULTS: 5,
  /** Default language. */
  DEFAULT_LANG: "en",
  /** Default country. */
  DEFAULT_COUNTRY: "us",
} as const;

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------
export const BROWSER = {
  /** Default viewport width. */
  VIEWPORT_WIDTH: 1280,
  /** Default viewport height. */
  VIEWPORT_HEIGHT: 720,
  /** Max content length for extract_content. */
  MAX_EXTRACT_LENGTH: 2000,
  /** Screenshot quality (JPEG). */
  SCREENSHOT_QUALITY: 80,
} as const;

// ---------------------------------------------------------------------------
// Sandbox (Docker)
// ---------------------------------------------------------------------------
export const SANDBOX = {
  /** Default Docker image. */
  DEFAULT_IMAGE: "python:3.12-slim",
  /** Default container working directory. */
  WORK_DIR: "/workspace",
  /** Default memory limit. */
  MEMORY_LIMIT: "512m",
  /** Default CPU limit. */
  CPU_LIMIT: 1.0,
  /** Default command timeout in seconds. */
  TIMEOUT_SEC: 300,
} as const;

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------
export const MCP = {
  /** Max tool name length after sanitization. */
  MAX_TOOL_NAME_LENGTH: 64,
  /** Tool name prefix pattern: mcp_{serverId}_{originalName}. */
  NAME_PREFIX: "mcp",
} as const;

// ---------------------------------------------------------------------------
// Crawl4AI
// ---------------------------------------------------------------------------
export const CRAWL = {
  /** Default page timeout in seconds. */
  TIMEOUT_SEC: 30,
  /** Min word count for content blocks. */
  WORD_COUNT_THRESHOLD: 10,
} as const;

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------
export const PLANNING = {
  /** Regex to extract [TYPE] tag from step text. */
  STEP_TYPE_REGEX: /\[([A-Z_]+)\]/,
  /** Max recursion limit for planning flow. */
  RECURSION_LIMIT: 100,
} as const;
