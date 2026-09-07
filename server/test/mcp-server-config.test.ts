import { afterEach, describe, expect, it, vi } from "vitest";

import { assertMcpLoopbackHost } from "../src/config.ts";

describe("inbound MCP listener guard", () => {
  afterEach(() => {
    delete process.env.KADY_MCP_ENABLED;
    vi.resetModules();
  });

  it("keeps the supported 127.0.0.1 default valid when MCP is enabled", () => {
    expect(() => assertMcpLoopbackHost("127.0.0.1", true)).not.toThrow();
  });

  it("also allows the IPv6 loopback literal", () => {
    expect(() => assertMcpLoopbackHost("::1", true)).not.toThrow();
  });

  it.each(["0.0.0.0", "192.168.1.20", "example.test", "localhost", "[::1]", ""])(
    "rejects non-loopback KADY_HOST=%j when MCP is enabled",
    (host) => {
      expect(() => assertMcpLoopbackHost(host, true)).toThrow(
        /KADY_MCP_ENABLED requires a loopback KADY_HOST/,
      );
    },
  );

  it("does not restrict the existing host knob while MCP is disabled", () => {
    expect(() => assertMcpLoopbackHost("0.0.0.0", false)).not.toThrow();
  });

  it("mounts inbound MCP separately from the outbound /mcp connector API", async () => {
    process.env.KADY_MCP_ENABLED = "1";
    vi.resetModules();
    const { buildApp } = await import("../src/index.ts");
    const app = await buildApp();
    try {
      const outbound = await app.inject({ method: "GET", url: "/mcp" });
      expect(outbound.statusCode).toBe(200);
      expect(outbound.json()).toMatchObject({ mcpServers: {}, disabledServers: {} });
      expect(app.hasRoute({ method: "POST", url: "/mcp-server" })).toBe(true);
      expect(app.hasRoute({ method: "GET", url: "/mcp-server" })).toBe(true);
    } finally {
      await app.close();
    }
  });
});
