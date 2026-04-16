/**
 * Custom Exception Types — Typed error hierarchy.
 *
 * Translated from: app/exceptions.py
 *
 * Provides specific error types for better error handling and reporting.
 */

/** Base error for all OpenManus errors. */
export class OpenManusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenManusError";
  }
}

/** Error during tool execution. */
export class ToolError extends OpenManusError {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Token limit exceeded — not retryable. */
export class TokenLimitExceeded extends OpenManusError {
  constructor(message: string) {
    super(message);
    this.name = "TokenLimitExceeded";
  }
}

/** Sandbox execution error. */
export class SandboxError extends OpenManusError {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/** Sandbox timeout error. */
export class SandboxTimeoutError extends SandboxError {
  constructor(message: string) {
    super(message);
    this.name = "SandboxTimeoutError";
  }
}
