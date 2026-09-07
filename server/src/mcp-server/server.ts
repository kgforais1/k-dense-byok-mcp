/**
 * Inbound MCP tool definitions for Kady.
 *
 * Keep handlers thin and return the same domain data used by the HTTP API. The
 * HTTP transport owns connection/session lifecycle in `http.ts`; this module
 * is deliberately transport-independent so its contract can be exercised with
 * the SDK's in-memory transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listProjects } from "../projects.ts";

export function createKadyMcpServer(): McpServer {
  const server = new McpServer({ name: "kady", version: "0.9.12" });

  server.registerTool(
    "list_projects",
    {
      title: "List Kady projects",
      description: "List the local Kady projects available to this MCP client.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const projects = listProjects();
      return {
        content: [{ type: "text", text: JSON.stringify({ projects }) }],
      };
    },
  );

  return server;
}
