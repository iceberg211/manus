/**
 * MCP Server — Expose OpenManus tools to external MCP clients.
 *
 * Translated from: app/mcp/server.py (180 lines)
 *
 * Registers all OpenManus tools as MCP-callable tools and serves them
 * via stdio transport. External agents can connect and use our tools.
 *
 * Requires: @modelcontextprotocol/sdk
 *
 * Usage:
 *   npx tsx src/mcp/server.ts
 */
import { bash } from "../tools/bash.js";
import { codeExecute } from "../tools/codeExecute.js";
import { strReplaceEditor } from "../tools/strReplaceEditor.js";
import { webSearch } from "../tools/webSearch.js";
import { logger } from "../utils/logger.js";

export async function startMCPServer() {
  try {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

    const server = new Server(
      { name: "openmanus", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    // Register tools
    const tools = [
      { impl: bash, name: "bash", description: "Execute bash commands in persistent session" },
      { impl: codeExecute, name: "code_execute", description: "Execute Python code" },
      { impl: strReplaceEditor, name: "str_replace_editor", description: "View, create, and edit files" },
      { impl: webSearch, name: "web_search", description: "Search the web" },
    ];

    server.setRequestHandler("tools/list" as any, async () => ({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.impl.schema ? JSON.parse(JSON.stringify(t.impl.schema)) : { type: "object", properties: {} },
      })),
    }));

    server.setRequestHandler("tools/call" as any, async (request: any) => {
      const { name, arguments: args } = request.params;
      const toolDef = tools.find((t) => t.name === name);
      if (!toolDef) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
      }
      try {
        const result = await (toolDef.impl as any).invoke(args ?? {});
        return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("MCP server started on stdio");
  } catch (e: any) {
    logger.error(`Failed to start MCP server: ${e.message}`);
    logger.error("Install: npm install @modelcontextprotocol/sdk");
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startMCPServer();
}
