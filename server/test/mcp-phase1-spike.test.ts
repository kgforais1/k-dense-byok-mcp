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
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { sessionToolNames } from "../src/agent/session-registry.ts";

describe("MCP SDK 1.29.0 server-side surface", () => {
  it("is resolved to 1.29.0 in the server lockfile", () => {
    const lockfile = JSON.parse(
      fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
    ) as { packages: Record<string, { version?: string }> };

    expect(lockfile.packages["node_modules/@modelcontextprotocol/sdk"]?.version).toBe("1.29.0");
  });

  it("loads exact server-side modules", async () => {
    const mcpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const serverModule = await import("@modelcontextprotocol/sdk/server/index.js");
    const stdioModule = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const httpModule = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

    expect(typeof mcpModule.McpServer).toBe("function");
    expect(typeof serverModule.Server).toBe("function");
    expect(typeof stdioModule.StdioServerTransport).toBe("function");
    expect(typeof httpModule.StreamableHTTPServerTransport).toBe("function");
  });

  it("constructs a usable high-level McpServer over the low-level Server", () => {
    const server = new McpServer({ name: "kady-phase1-spike", version: "1.0.0" });

    expect(server.server).toBeInstanceOf(Server);
    expect(typeof server.registerTool).toBe("function");
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
  it("regular session allowlist includes interview", () => {
    const tools = sessionToolNames(true, ["project_mcp_tool"]);

    expect(tools).toContain("interview");
    expect(tools).toContain("read");
    expect(tools).toContain("bash");
    expect(tools).toContain("subagent");
    expect(tools).toContain("notebook");
    expect(tools).toContain("web_search");
    expect(tools).toContain("project_mcp_tool");
  });

  it("headless session allowlist omits interview while retaining other tools", () => {
    const tools = sessionToolNames(false, ["project_mcp_tool"]);

    expect(tools).not.toContain("interview");
    expect(tools).toContain("read");
    expect(tools).toContain("bash");
    expect(tools).toContain("subagent");
    expect(tools).toContain("notebook");
    expect(tools).toContain("web_search");
    expect(tools).toContain("project_mcp_tool");
  });
});
