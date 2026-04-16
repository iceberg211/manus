/**
 * Configuration System — TOML config loading with typed settings.
 *
 * Translated from: app/config.py (373 lines)
 *
 * Supports:
 * - config/config.toml (primary) or config/config.example.toml (fallback)
 * - LLM settings with per-agent overrides
 * - Browser, Search, Sandbox, MCP, Daytona settings
 * - Environment variable fallbacks for API keys
 */
import "dotenv/config"; // 自动加载 .env 到 process.env
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

// ---------------------------------------------------------------------------
// Settings interfaces (match Python Pydantic models)
// ---------------------------------------------------------------------------

export interface LLMSettings {
  model: string;
  base_url: string;
  api_key: string;
  max_tokens: number;
  max_input_tokens?: number;
  temperature: number;
  api_type: string;
  api_version: string;
}

export interface ProxySettings {
  server: string;
  username?: string;
  password?: string;
}

export interface BrowserSettings {
  headless: boolean;
  disable_security: boolean;
  extra_chromium_args: string[];
  chrome_instance_path?: string;
  wss_url?: string;
  cdp_url?: string;
  proxy?: ProxySettings;
  max_content_length: number;
}

export interface SearchSettings {
  engine: string;
  fallback_engines: string[];
  retry_delay: number;
  max_retries: number;
  lang: string;
  country: string;
}

export interface SandboxSettings {
  use_sandbox: boolean;
  image: string;
  work_dir: string;
  memory_limit: string;
  cpu_limit: number;
  timeout: number;
  network_enabled: boolean;
}

export interface MCPServerConfig {
  type: "sse" | "stdio";
  url?: string;
  command?: string;
  args: string[];
}

export interface MCPSettings {
  server_reference: string;
  servers: Record<string, MCPServerConfig>;
}

export interface DaytonaSettings {
  daytona_api_key: string;
  daytona_server_url: string;
  daytona_target: string;
  sandbox_image_name: string;
  sandbox_entrypoint: string;
  vnc_password: string;
}

export interface RunflowSettings {
  use_data_analysis_agent: boolean;
}

export interface AppConfig {
  llm: Record<string, LLMSettings>;
  sandbox: SandboxSettings;
  browser: BrowserSettings | null;
  search: SearchSettings | null;
  mcp: MCPSettings;
  runflow: RunflowSettings;
  daytona: DaytonaSettings | null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SANDBOX: SandboxSettings = {
  use_sandbox: false,
  image: "python:3.12-slim",
  work_dir: "/workspace",
  memory_limit: "512m",
  cpu_limit: 1.0,
  timeout: 300,
  network_enabled: false,
};

const DEFAULT_SEARCH: SearchSettings = {
  engine: "google",
  fallback_engines: ["duckduckgo", "baidu", "bing"],
  retry_delay: 60,
  max_retries: 3,
  lang: "en",
  country: "us",
};

const DEFAULT_MCP: MCPSettings = {
  server_reference: "app.mcp.server",
  servers: {},
};

const DEFAULT_RUNFLOW: RunflowSettings = {
  use_data_analysis_agent: false,
};

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function findConfigPath(projectRoot: string): string | null {
  const primary = join(projectRoot, "config", "config.toml");
  if (existsSync(primary)) return primary;
  const example = join(projectRoot, "config", "config.example.toml");
  if (existsSync(example)) return example;
  return null;
}

function loadMCPServers(projectRoot: string): Record<string, MCPServerConfig> {
  const mcpPath = join(projectRoot, "config", "mcp.json");
  if (!existsSync(mcpPath)) return {};

  try {
    const data = JSON.parse(readFileSync(mcpPath, "utf-8"));
    const servers: Record<string, MCPServerConfig> = {};
    for (const [id, cfg] of Object.entries(data.mcpServers ?? {})) {
      const c = cfg as any;
      servers[id] = {
        type: c.type,
        url: c.url,
        command: c.command,
        args: c.args ?? [],
      };
    }
    return servers;
  } catch {
    return {};
  }
}

/**
 * Load configuration from TOML file.
 *
 * NOTE: Node.js doesn't have built-in TOML parsing.
 * This implementation reads the file and does basic key=value parsing.
 * For full TOML support, install `smol-toml`: npm install smol-toml
 */
export async function loadConfig(projectRoot?: string): Promise<AppConfig> {
  const root = projectRoot ?? resolve(process.cwd());
  const workspaceRoot = join(root, "workspace");

  // Try to load TOML config
  const configPath = findConfigPath(root);
  let rawConfig: Record<string, any> = {};

  if (configPath) {
    try {
      // Try smol-toml if available
      const tomlContent = readFileSync(configPath, "utf-8");
      try {
        const { parse } = await import("smol-toml");
        rawConfig = parse(tomlContent);
      } catch {
        // smol-toml parse failed or not found — fall back to env vars
      }
    } catch {
      // Config file read error — use defaults
    }
  }

  // Build LLM settings
  const llmRaw = rawConfig.llm ?? {};
  const defaultLLM: LLMSettings = {
    model: llmRaw.model ?? process.env.MODEL_NAME ?? process.env.OPENAI_MODEL ?? "gpt-4o",
    base_url: llmRaw.base_url ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    api_key: llmRaw.api_key ?? process.env.OPENAI_API_KEY ?? "",
    max_tokens: llmRaw.max_tokens ?? 4096,
    max_input_tokens: llmRaw.max_input_tokens,
    temperature: llmRaw.temperature ?? 0,
    api_type: llmRaw.api_type ?? "openai",
    api_version: llmRaw.api_version ?? "",
  };

  const llmSettings: Record<string, LLMSettings> = { default: defaultLLM };
  // Agent-specific overrides
  for (const [key, val] of Object.entries(llmRaw)) {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      llmSettings[key] = { ...defaultLLM, ...(val as any) };
    }
  }

  // Browser settings
  const browserRaw = rawConfig.browser;
  const browserSettings: BrowserSettings | null = browserRaw
    ? {
        headless: browserRaw.headless ?? false,
        disable_security: browserRaw.disable_security ?? true,
        extra_chromium_args: browserRaw.extra_chromium_args ?? [],
        chrome_instance_path: browserRaw.chrome_instance_path,
        wss_url: browserRaw.wss_url,
        cdp_url: browserRaw.cdp_url,
        proxy: browserRaw.proxy?.server ? browserRaw.proxy : undefined,
        max_content_length: browserRaw.max_content_length ?? 2000,
      }
    : null;

  // Search settings
  const searchRaw = rawConfig.search;
  const searchSettings: SearchSettings = searchRaw
    ? { ...DEFAULT_SEARCH, ...searchRaw }
    : DEFAULT_SEARCH;

  // Sandbox settings
  const sandboxRaw = rawConfig.sandbox;
  const sandboxSettings: SandboxSettings = sandboxRaw
    ? { ...DEFAULT_SANDBOX, ...sandboxRaw }
    : DEFAULT_SANDBOX;

  // MCP settings
  const mcpServers = loadMCPServers(root);
  const mcpSettings: MCPSettings = {
    ...DEFAULT_MCP,
    ...(rawConfig.mcp ?? {}),
    servers: { ...(rawConfig.mcp?.servers ?? {}), ...mcpServers },
  };

  // Daytona settings
  const daytonaRaw = rawConfig.daytona;
  const daytonaSettings: DaytonaSettings | null = daytonaRaw
    ? {
        daytona_api_key: daytonaRaw.daytona_api_key ?? "",
        daytona_server_url: daytonaRaw.daytona_server_url ?? "https://app.daytona.io/api",
        daytona_target: daytonaRaw.daytona_target ?? "us",
        sandbox_image_name: daytonaRaw.sandbox_image_name ?? "whitezxj/sandbox:0.1.0",
        sandbox_entrypoint: daytonaRaw.sandbox_entrypoint ?? "",
        vnc_password: daytonaRaw.VNC_password ?? "123456",
      }
    : null;

  // Runflow
  const runflowRaw = rawConfig.runflow;
  const runflowSettings: RunflowSettings = runflowRaw
    ? { ...DEFAULT_RUNFLOW, ...runflowRaw }
    : DEFAULT_RUNFLOW;

  return {
    llm: llmSettings,
    sandbox: sandboxSettings,
    browser: browserSettings,
    search: searchSettings,
    mcp: mcpSettings,
    runflow: runflowSettings,
    daytona: daytonaSettings,
  };
}

/** Project root directory — the project itself, not the parent. */
export const PROJECT_ROOT = resolve(process.cwd());

/** Workspace root (for file operations). Defaults to {PROJECT_ROOT}/workspace. */
export const WORKSPACE_ROOT = join(PROJECT_ROOT, "workspace");

/** Singleton config instance. */
let _config: AppConfig | null = null;

/** Get config. Uses defaults until loadConfig() is called. */
export function getConfig(): AppConfig {
  if (!_config) {
    // Sync fallback — uses defaults + env vars only (no TOML parsing)
    _config = buildConfigFromEnv();
  }
  return _config;
}

/** Initialize config asynchronously (enables TOML parsing). */
export async function initConfig(projectRoot?: string): Promise<AppConfig> {
  _config = await loadConfig(projectRoot);
  return _config;
}

/** Sync config from environment variables only. */
function buildConfigFromEnv(): AppConfig {
  return {
    llm: {
      default: {
        model: process.env.MODEL_NAME ?? process.env.OPENAI_MODEL ?? "gpt-4o",
        base_url: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        api_key: process.env.OPENAI_API_KEY ?? "",
        max_tokens: 4096,
        temperature: 0,
        api_type: "openai",
        api_version: "",
      },
    },
    sandbox: { use_sandbox: false, image: "python:3.12-slim", work_dir: "/workspace", memory_limit: "512m", cpu_limit: 1.0, timeout: 300, network_enabled: false },
    browser: null,
    search: { engine: "google", fallback_engines: ["duckduckgo"], retry_delay: 60, max_retries: 3, lang: "en", country: "us" },
    mcp: { server_reference: "", servers: {} },
    runflow: { use_data_analysis_agent: false },
    daytona: null,
  };
}

// Re-export constants
export * from "./constants.js";
export * from "./persistence.js";
