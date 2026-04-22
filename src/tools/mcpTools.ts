/**
 * MCP Dynamic Tool Loading — Connect to MCP servers and convert tools.
 *
 * Translated from: app/tool/mcp.py (195 lines)
 *                  MCPClientTool, MCPClients
 *
 * Key behaviors preserved:
 * 1. Connect via stdio or SSE transport
 * 2. List tools from server → create LangChain tool proxy for each
 * 3. Tool name: mcp_{serverId}_{originalName} (sanitized)
 * 4. Name sanitization: [a-zA-Z0-9_-], max 64 chars
 * 5. Execute via client.callTool() → extract TextContent
 * 6. Support multiple servers simultaneously
 * 7. Cleanup: disconnect all sessions
 */
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "@/utils/logger";

// Types for MCP config
export interface MCPServerConfig {
  id: string;
  type: "stdio" | "sse";
  /** Command for stdio transport. */
  command?: string;
  /** Args for stdio transport. */
  args?: string[];
  /** URL for SSE transport. */
  url?: string;
}

interface MCPConnection {
  serverId: string;
  client: any; // MCP Client instance
  transport: any; // Transport instance
  tools: DynamicStructuredTool[];
}

/** Sanitize tool name (matches Python MCPClients._sanitize_tool_name). */
function sanitizeName(name: string): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  sanitized = sanitized.replace(/_+/g, "_");
  sanitized = sanitized.replace(/^_+|_+$/g, "");
  if (sanitized.length > 64) sanitized = sanitized.slice(0, 64);
  return sanitized;
}

/**
 * Convert a JSON Schema object to a Zod schema (simplified).
 * Handles common types: string, number, integer, boolean, object, array.
 */
function jsonSchemaToZod(schema: any): z.ZodType {
  if (!schema || !schema.type) return z.any();

  switch (schema.type) {
    case "string":
      return z.string().describe(schema.description ?? "");
    case "number":
    case "integer":
      return z.number().describe(schema.description ?? "");
    case "boolean":
      return z.boolean().describe(schema.description ?? "");
    case "array":
      return z.array(jsonSchemaToZod(schema.items ?? {})).describe(schema.description ?? "");
    case "object": {
      const shape: Record<string, z.ZodType> = {};
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      for (const [key, propSchema] of Object.entries(properties)) {
        const zodProp = jsonSchemaToZod(propSchema as any);
        shape[key] = required.has(key) ? zodProp : zodProp.optional();
      }
      return z.object(shape).describe(schema.description ?? "");
    }
    default:
      return z.any();
  }
}

/**
 * MCPToolManager — Manages connections to MCP servers and their tools.
 *
 * Translated from: MCPClients class in app/tool/mcp.py
 */
export class MCPToolManager {
  private connections: Map<string, MCPConnection> = new Map();

  /** Connect to an MCP server via stdio and load its tools. */
  async connectStdio(config: MCPServerConfig): Promise<DynamicStructuredTool[]> {
    if (!config.command) throw new Error("Command required for stdio transport");

    const serverId = config.id;

    // Dynamic imports — MCP SDK
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/stdio.js"
    );

    // Disconnect existing connection if any
    if (this.connections.has(serverId)) {
      await this.disconnect(serverId);
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
    });

    const client = new Client(
      { name: "openmanus-langgraph", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    const { tools: mcpTools } = await client.listTools();

    // Convert MCP tools to LangChain tools
    const langchainTools = mcpTools.map((mcpTool: any) => {
      const toolName = sanitizeName(`mcp_${serverId}_${mcpTool.name}`);
      const originalName = mcpTool.name;

      const zodSchema = jsonSchemaToZod(mcpTool.inputSchema ?? { type: "object", properties: {} });

      return new DynamicStructuredTool({
        name: toolName,
        description: mcpTool.description || `MCP tool: ${originalName}`,
        schema: zodSchema as z.ZodObject<any>,
        func: async (input: Record<string, any>) => {
          try {
            const result = await client.callTool({
              name: originalName,
              arguments: input,
            });
            // Extract TextContent (matches Python MCPClientTool.execute)
            const contentArr = Array.isArray(result.content) ? result.content : [];
            const texts = contentArr
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text);
            return texts.join(", ") || "No output returned.";
          } catch (e: any) {
            return `Error executing MCP tool: ${e.message}`;
          }
        },
      });
    });

    this.connections.set(serverId, {
      serverId,
      client,
      transport,
      tools: langchainTools,
    });

    logger.info(
      `[MCP] Connected to ${serverId}: ${langchainTools.map((t: any) => t.name).join(", ")}`
    );

    return langchainTools;
  }

  /** Connect to an MCP server via SSE and load its tools. */
  async connectSSE(config: MCPServerConfig): Promise<DynamicStructuredTool[]> {
    if (!config.url) throw new Error("URL required for SSE transport");

    const serverId = config.id;

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { SSEClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/sse.js"
    );

    if (this.connections.has(serverId)) {
      await this.disconnect(serverId);
    }

    const transport = new SSEClientTransport(new URL(config.url));
    const client = new Client(
      { name: "openmanus-langgraph", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    const { tools: mcpTools } = await client.listTools();

    const langchainTools = mcpTools.map((mcpTool: any) => {
      const toolName = sanitizeName(`mcp_${serverId}_${mcpTool.name}`);
      const originalName = mcpTool.name;

      const zodSchema = jsonSchemaToZod(mcpTool.inputSchema ?? { type: "object", properties: {} });

      return new DynamicStructuredTool({
        name: toolName,
        description: mcpTool.description || `MCP tool: ${originalName}`,
        schema: zodSchema as z.ZodObject<any>,
        func: async (input: Record<string, any>) => {
          try {
            const result = await client.callTool({
              name: originalName,
              arguments: input,
            });
            const contentArr = Array.isArray(result.content) ? result.content : [];
            const texts = contentArr
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text);
            return texts.join(", ") || "No output returned.";
          } catch (e: any) {
            return `Error executing MCP tool: ${e.message}`;
          }
        },
      });
    });

    this.connections.set(serverId, {
      serverId,
      client,
      transport,
      tools: langchainTools,
    });

    logger.info(
      `[MCP] Connected to ${serverId} via SSE: ${langchainTools.map((t: any) => t.name).join(", ")}`
    );

    return langchainTools;
  }

  /** Connect to server based on config type. */
  async connect(config: MCPServerConfig): Promise<DynamicStructuredTool[]> {
    if (config.type === "stdio") return this.connectStdio(config);
    if (config.type === "sse") return this.connectSSE(config);
    throw new Error(`Unknown MCP transport type: ${config.type}`);
  }

  /** Disconnect from a specific server. */
  async disconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;

    try {
      await conn.client.close();
    } catch {
      // Ignore disconnect errors
    }

    this.connections.delete(serverId);
    logger.info(`[MCP] Disconnected from ${serverId}`);
  }

  /** Disconnect from all servers. */
  async disconnectAll(): Promise<void> {
    for (const serverId of [...this.connections.keys()]) {
      await this.disconnect(serverId);
    }
  }

  /** Get all tools from all connected servers. */
  getAllTools(): DynamicStructuredTool[] {
    return [...this.connections.values()].flatMap((c) => c.tools);
  }

  /** Get tools from a specific server. */
  getServerTools(serverId: string): DynamicStructuredTool[] {
    return this.connections.get(serverId)?.tools ?? [];
  }

  // -----------------------------------------------------------------------
  // 7b-7: Dynamic tool refresh (from app/agent/mcp.py _refresh_tools)
  // -----------------------------------------------------------------------

  /** Track tool schemas for change detection. */
  private toolSchemas = new Map<string, string>(); // name → JSON schema hash

  /**
   * Refresh tools from all connected servers. Detects added/removed/changed tools.
   *
   * Returns { added, removed, changed } tool names.
   * Call this periodically (e.g., every N agent steps) to pick up server changes.
   */
  async refreshTools(): Promise<{ added: string[]; removed: string[]; changed: string[] }> {
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];

    for (const [serverId, conn] of this.connections) {
      try {
        const { tools: mcpTools } = await conn.client.listTools();
        const currentNames = new Set<string>();

        for (const mcpTool of mcpTools) {
          const toolName = sanitizeName(`mcp_${serverId}_${mcpTool.name}`);
          currentNames.add(toolName);
          const schemaStr = JSON.stringify(mcpTool.inputSchema ?? {});

          if (!this.toolSchemas.has(toolName)) {
            added.push(toolName);
          } else if (this.toolSchemas.get(toolName) !== schemaStr) {
            changed.push(toolName);
          }
          this.toolSchemas.set(toolName, schemaStr);
        }

        // Detect removed tools
        for (const existingTool of conn.tools) {
          if (!currentNames.has(existingTool.name)) {
            removed.push(existingTool.name);
            this.toolSchemas.delete(existingTool.name);
          }
        }

        // Rebuild tools for this server if anything changed
        if (added.length > 0 || removed.length > 0 || changed.length > 0) {
          await this._initialize_and_list_tools_for(serverId, conn.client);
        }
      } catch (e: any) {
        logger.error(`Failed to refresh tools for ${serverId}: ${e.message}`);
      }
    }

    if (added.length) logger.info(`MCP tools added: ${added.join(", ")}`);
    if (removed.length) logger.info(`MCP tools removed: ${removed.join(", ")}`);
    if (changed.length) logger.info(`MCP tools changed: ${changed.join(", ")}`);

    return { added, removed, changed };
  }

  /** Rebuild tool list for a specific server. */
  private async _initialize_and_list_tools_for(serverId: string, client: any): Promise<void> {
    const { tools: mcpTools } = await client.listTools();
    const conn = this.connections.get(serverId);
    if (!conn) return;

    conn.tools = mcpTools.map((mcpTool: any) => {
      const toolName = sanitizeName(`mcp_${serverId}_${mcpTool.name}`);
      const originalName = mcpTool.name;
      const zodSchema = jsonSchemaToZod(mcpTool.inputSchema ?? { type: "object", properties: {} });

      return new DynamicStructuredTool({
        name: toolName,
        description: mcpTool.description || `MCP tool: ${originalName}`,
        schema: zodSchema as z.ZodObject<any>,
        func: async (input: Record<string, any>) => {
          try {
            const result = await client.callTool({ name: originalName, arguments: input });
            const contentArr = Array.isArray(result.content) ? result.content : [];
            const texts = contentArr.filter((c: any) => c.type === "text").map((c: any) => c.text);
            return texts.join(", ") || "No output returned.";
          } catch (e: any) {
            return `Error executing MCP tool: ${e.message}`;
          }
        },
      });
    });
  }

  /** Check if any server has tools available. */
  hasTools(): boolean {
    return this.getAllTools().length > 0;
  }
}

/**
 * Load MCP tools from a config file (matches config/mcp.json format).
 *
 * Usage:
 * ```ts
 * const mcpManager = new MCPToolManager();
 * const tools = await loadMCPToolsFromConfig(mcpManager, [
 *   { id: "filesystem", type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
 * ]);
 * const agent = createManusAgent({ extraTools: tools });
 * ```
 */
export async function loadMCPToolsFromConfig(
  manager: MCPToolManager,
  configs: MCPServerConfig[]
): Promise<DynamicStructuredTool[]> {
  const allTools: DynamicStructuredTool[] = [];

  for (const config of configs) {
    try {
      const tools = await manager.connect(config);
      allTools.push(...tools);
    } catch (e: any) {
      logger.error(`[MCP] Failed to connect to ${config.id}: ${e.message}`);
    }
  }

  return allTools;
}
