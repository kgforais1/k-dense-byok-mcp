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
}

const sessionHeader = "mcp-session-id";

/**
 * Kept distinct from `/mcp`, which is Kady's existing outbound-connector API.
 * MCP clients configure this URL directly, so a dedicated endpoint preserves
 * both directions without a Fastify GET/SSE route collision.
 */
export const INBOUND_MCP_PATH = "/mcp-server";

function requestedSessionId(headers: Record<string, string | string[] | undefined>): string | undefined {
  const value = headers[sessionHeader];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Mount the opt-in inbound MCP endpoint on Kady's existing listener.
 *
 * Streamable HTTP is stateful here: an MCP transport session is an adapter
 * connection only, while Kady research sessions are explicitly created by the
 * `create_research_session` tool.
 *
 * Project scope is deliberately NOT a property of the connection. Every tool
 * resolves `currentProjectId()` from the `X-Project-Id` on its own request,
 * exactly as the REST API does, so one connection can address several projects
 * and a client that sends no header gets the default. An earlier version
 * cached the initializing request's project id here; nothing consumed it, and
 * keeping it invited a future handler to trust a value that can disagree with
 * the request actually being served.
 */
export async function registerInboundMcpRoutes(
  app: FastifyInstance,
  enabled = MCP_ENABLED,
): Promise<void> {
  if (!enabled) return;

  const connections = new Map<string, McpConnection>();

  app.all(INBOUND_MCP_PATH, async (req, reply) => {
    const requestedId = requestedSessionId(req.headers);
    let connection = requestedId ? connections.get(requestedId) : undefined;
    const existingConnection = connection !== undefined;
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
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sessionId) => {
          if (connection) connections.set(sessionId, connection);
        },
      });
      const server = createKadyMcpServer(app.log);
      // Set this before server.connect(): Protocol.connect composes the
      // transport's existing close hook with its own cleanup. Assigning it
      // afterwards would replace that SDK hook and make server.close() recurse
      // through transport.close().
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) connections.delete(id);
      };
      try {
        await server.connect(transport);
      } catch (error) {
        // This connection never enters the cache, so normal onclose and app
        // shutdown cleanup cannot reach it. Close both SDK objects directly.
        await Promise.allSettled([transport.close(), server.close()]);
        throw error;
      }
      connection = { server, transport };
      newConnection = true;
    }

    // The SDK writes directly to Node's ServerResponse. Fastify must not try
    // to serialize a second response after the transport has completed.
    reply.hijack();
    try {
      await connection.transport.handleRequest(req.raw, reply.raw, req.body);
      const establishedId = connection.transport.sessionId;
      if (establishedId && !existingConnection) {
        connections.set(establishedId, connection);
        newConnection = false;
      } else if (newConnection) {
        // A malformed or non-initialize first request never gets a session id
        // and therefore cannot be reached by onclose or app shutdown cleanup.
        await Promise.allSettled([connection.transport.close(), connection.server.close()]);
        newConnection = false;
      }
    } catch (error) {
      req.log.error({ error, projectId: currentProjectId() }, "MCP request failed");
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
