import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createProject } from "../src/projects.ts";
import { createKadyMcpServer } from "../src/mcp-server/server.ts";

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
});

describe("inbound MCP Phase 2 tool contract", () => {
  it("serves list_projects through the SDK server contract", async () => {
    createProject({ projectId: "mcp-contract", name: "MCP contract" });
    const server = createKadyMcpServer();
    const client = new Client({ name: "kady-mcp-contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect((await client.listTools()).tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "list_projects" })]),
    );

    const result = await client.callTool({ name: "list_projects" });
    const text = result.content.find((item) => item.type === "text");
    expect(text).toMatchObject({ type: "text" });
    expect(JSON.parse((text as { text: string }).text)).toMatchObject({
      projects: expect.arrayContaining([expect.objectContaining({ id: "mcp-contract" })]),
    });
  });
});
