/** Streamable HTTP mounting for Kady's inbound MCP server. */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_ENABLED } from "../config.ts";
import { currentProjectId } from "../scope.ts";
import { createKadyMcpServer } from "./server.ts";

interface McpConnection {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  projectId: string;
}

const sessionHeader = "mcp-session-id";

function requestedSessionId(headers: Record<string, string | string[] | undefined>): string | undefined {
  const value = headers[sessionHeader];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Mount the opt-in inbound MCP endpoint on Kady's existing listener.
 *
 * Streamable HTTP is stateful here: an MCP transport session is an adapter
 * connection only, while Kady research sessions are explicitly created by the
 * `create_research_session` tool added later in Phase 2. Capture the project
 * id at initialization so future stateful tools can bind it to the connection;
 * the current project-independent `list_projects` tool does not consume it.
 */
export async function registerInboundMcpRoutes(
  app: FastifyInstance,
  enabled = MCP_ENABLED,
): Promise<void> {
  if (!enabled) return;

  const connections = new Map<string, McpConnection>();

  app.all("/mcp", async (req, reply) => {
    const requestedId = requestedSessionId(req.headers);
    let connection = requestedId ? connections.get(requestedId) : undefined;
    let newConnection = false;

    if (requestedId && !connection) {
      reply.code(404);
      return { detail: "Unknown MCP session" };
    }

    if (!connection) {
      // The SDK initializes the session while it handles the first request.
      // Register from this callback, rather than only after handleRequest(),
      // so a client that pipelines a follow-up request cannot observe a 404
      // in the small window before the initialize response has completed.
      let createdConnection: McpConnection | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sessionId) => {
          if (createdConnection) connections.set(sessionId, createdConnection);
        },
      });
      const server = createKadyMcpServer();
      const projectId = currentProjectId();
      try {
        await server.connect(transport);
      } catch (error) {
        // This connection never enters the cache, so normal onclose and app
        // shutdown cleanup cannot reach it. Close both SDK objects directly.
        await Promise.allSettled([transport.close(), server.close()]);
        throw error;
      }
      connection = { server, transport, projectId };
      createdConnection = connection;
      newConnection = true;
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) connections.delete(id);
        void server.close().catch(() => {});
      };
    }

    // The SDK writes directly to Node's ServerResponse. Fastify must not try
    // to serialize a second response after the transport has completed.
    reply.hijack();
    try {
      await connection.transport.handleRequest(req.raw, reply.raw, req.body);
      const establishedId = connection.transport.sessionId;
      if (establishedId) {
        connections.set(establishedId, connection);
        newConnection = false;
      } else if (newConnection) {
        // A malformed or non-initialize first request never gets a session id
        // and therefore cannot be reached by onclose or app shutdown cleanup.
        await Promise.allSettled([connection.transport.close(), connection.server.close()]);
        newConnection = false;
      }
    } catch (error) {
      req.log.error({ error, projectId: connection.projectId }, "MCP request failed");
      if (newConnection) {
        // An initial request may fail after the SDK has allocated a transport
        // session but before it is cached. Close it here so neither the
        // transport nor server relies on garbage collection for cleanup.
        const establishedId = connection.transport.sessionId;
        if (establishedId) connections.delete(establishedId);
        await Promise.allSettled([connection.transport.close(), connection.server.close()]);
      }
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ detail: "MCP request failed" }));
      }
    }
  });

  app.addHook("onClose", async () => {
    const open = [...connections.values()];
    connections.clear();
    await Promise.all(open.map(async ({ server, transport }) => {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }));
  });
}
