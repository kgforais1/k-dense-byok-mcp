import { describe, expect, it } from "vitest";

import { assertMcpLoopbackHost } from "../src/config.ts";

describe("inbound MCP listener guard", () => {
  it("keeps the supported 127.0.0.1 default valid when MCP is enabled", () => {
    expect(() => assertMcpLoopbackHost("127.0.0.1", true)).not.toThrow();
  });

  it("also allows the IPv6 loopback literal", () => {
    expect(() => assertMcpLoopbackHost("::1", true)).not.toThrow();
  });

  it.each(["0.0.0.0", "192.168.1.20", "example.test", "localhost", ""])(
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
});
