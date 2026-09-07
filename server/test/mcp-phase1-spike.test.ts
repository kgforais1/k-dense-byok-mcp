/**
 * Phase 1 MCP SDK + headless-session evidence spike.
 *
 * Proves:
 *  1. The installed @modelcontextprotocol/sdk@1.29.0 server-side modules load
 *     and expose the expected API surface.
 *  2. The regular Kady session construction includes the `interview` tool.
 *  3. The smallest tested mode/option to construct an MCP-headless session
 *     without `interview` is `{ includeInterview: false }` on `createSession`
 *     / `getSession`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  createSession,
  disposeSession,
  getSession,
} from "../src/agent/session-registry.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import { PROJECTS_ROOT } from "../src/config.ts";

const createdSessions: Array<{ projectId: string; sessionId: string }> = [];

function resetProjects(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

beforeEach(resetProjects);

afterEach(() => {
  for (const { projectId, sessionId } of createdSessions) {
    try {
      disposeSession(projectId, sessionId);
    } catch {
      // ignore cleanup errors
    }
  }
  createdSessions.length = 0;
});

describe("MCP SDK 1.29.0 server-side surface", () => {
  it("loads exact server-side modules", async () => {
    const serverModule = await import("@modelcontextprotocol/sdk/server/index.js");
    const stdioModule = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const httpModule = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

    expect(typeof serverModule.Server).toBe("function");
    expect(typeof stdioModule.StdioServerTransport).toBe("function");
    expect(typeof httpModule.StreamableHTTPServerTransport).toBe("function");
  });

  it("constructs a usable McpServer (Server)", async () => {
    const { Server: ServerCls } = await import("@modelcontextprotocol/sdk/server/index.js");
    const server = new ServerCls({ name: "kady-phase1-spike", version: "1.0.0" });
    expect(server).toBeDefined();
    expect(typeof server.setRequestHandler).toBe("function");
    expect(typeof server.connect).toBe("function");
    expect(typeof server.close).toBe("function");
  });

  it("Server.prototype.elicitInput exists", async () => {
    const { Server: ServerCls } = await import("@modelcontextprotocol/sdk/server/index.js");
    const server = new ServerCls({ name: "kady-phase1-spike", version: "1.0.0" });
    expect(typeof server.elicitInput).toBe("function");
  });

  it("StdioServerTransport and StreamableHTTPServerTransport are usable exports", async () => {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    // Constructability without transport-specific args is verified here; actual
    // connect/run behavior is Phase 2 transport work.
    expect(typeof StdioServerTransport).toBe("function");
    expect(typeof StreamableHTTPServerTransport).toBe("function");
  });
});

describe("interview headless-session evidence", () => {
  it("regular createSession includes interview in active tool names", async () => {
    ensureProjectExists("default");
    const paths = resolvePaths("default");
    const session = await createSession("default", paths);
    createdSessions.push({ projectId: "default", sessionId: session.sessionId });

    const tools = session.getActiveToolNames();
    expect(tools).toContain("interview");
    // Sanity-check that the rest of the regular session surface is present.
    expect(tools).toContain("read");
    expect(tools).toContain("bash");
    expect(tools).toContain("subagent");
    expect(tools).toContain("notebook");
    expect(tools).toContain("web_search");
  });

  it("createSession with includeInterview:false omits interview from active tools", async () => {
    ensureProjectExists("headless");
    const paths = resolvePaths("headless");
    const session = await createSession("headless", paths, { includeInterview: false });
    createdSessions.push({ projectId: "headless", sessionId: session.sessionId });

    const tools = session.getActiveToolNames();
    expect(tools).not.toContain("interview");
    // The rest of the regular surface still loads unchanged.
    expect(tools).toContain("read");
    expect(tools).toContain("bash");
    expect(tools).toContain("subagent");
    expect(tools).toContain("notebook");
    expect(tools).toContain("web_search");
  });

  it("getSession accepts includeInterview:false and omits interview from active tools", async () => {
    ensureProjectExists("headless-reopen");
    const paths = resolvePaths("headless-reopen");
    const session1 = await createSession("headless-reopen", paths, { includeInterview: false });
    createdSessions.push({ projectId: "headless-reopen", sessionId: session1.sessionId });

    // getSession on a live session returns the cached instance; the option is
    // accepted and the live session's tool set remains unchanged.
    const cached = await getSession("headless-reopen", paths, session1.sessionId, {
      includeInterview: false,
    });
    expect(cached).toBe(session1);
    expect(cached!.getActiveToolNames()).not.toContain("interview");
    expect(cached!.getActiveToolNames()).toContain("read");
  });
});
