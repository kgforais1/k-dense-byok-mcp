// FORK: regression for Pi 1.1 keeping MCP tools past a child allowlist.
// Pi 1.1 AgentSession._isAllowedTool keeps MCP tools unless the allowlist is
// empty or names an `mcp__` tool, so an explicit child `tools` allowlist no
// longer excluded unlisted MCP tools. The Kady host seam
// (subagent-host.mjs restrictChildMcpToAllowlist) restores the pre-1.1 rule for
// both tools registered at construction (custom tools) and tools that register
// late (MCP connecting after session start). This exercises the real installed
// child-session factory.
import { required as requireValue } from "../src/required.ts";
import type { FixtureChildSession } from "./helpers/extension-types.ts";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { waitFor } from "./helpers/timing.ts";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import { disposeProjectSessions } from "../src/agent/session-registry.ts";
import { subagentsPackageDir } from "../src/agent/agent-files.ts";
import { patchSubagents } from "../scripts/patch-subagents.mjs";

beforeEach(() => { fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); patchSubagents(); });
afterEach(async () => { await disposeProjectSessions("mcpceiling"); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const internal = (file: string) => import(pathToFileURL(path.join(subagentsPackageDir(), file)).href);

const LATE_MCP = "mcp__echo__echo"; // registers when the MCP echo server connects
const EARLY_MCP = "mcp__fixture__denied"; // registered at construction as a custom tool

/** An MCP-named tool present before the host seam runs (custom = already registered). */
const earlyMcpTool: ToolDefinition = {
  name: EARLY_MCP,
  label: "Early MCP fixture",
  description: "Forbidden MCP fixture, registered before the allowlist seam.",
  parameters: Type.Object({}),
  exposure: "codemode",
  execute: () => Promise.resolve({ content: [{ type: "text", text: "denied" }], details: {} }),
};

/** Create a real child through the installed factory with an MCP echo server. */
async function createChild(tools?: string[]) {
  const paths = ensureProjectExists("mcpceiling");
  fs.mkdirSync(path.join(paths.sandbox, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(paths.sandbox, ".pi", "mcp.json"), JSON.stringify({
    mcpServers: { echo: { command: process.execPath, args: [path.join(import.meta.dirname, "fixtures/echo-mcp-server.mjs")], exposure: "codemode" } },
  }));
  vi.stubEnv("KADY_SUBAGENT_HOST_MODULE", pathToFileURL(path.resolve(import.meta.dirname, "../src/agent/subagent-host.mjs")).href);
  vi.stubEnv("PI_SUBAGENT_CHILD", "");
  // Load the module object at runtime so the child factory still receives every
  // export. A static namespace import is what DeepSource flags, and naming each
  // export would drop ones the factory reads.
  const sdk = await import("@earendil-works/pi-coding-agent");
  const captured: AgentSession[] = [];
  const { createDefaultChildSessionFactory } = await internal("src/runs/shared/child-session.js");
  const factory = createDefaultChildSessionFactory({
    loadPiCodingAgent: () => Promise.resolve({
      ...sdk,
      createAgentSession: async (args: Parameters<typeof sdk.createAgentSession>[0]) => {
        const result = await sdk.createAgentSession({ ...args, customTools: [earlyMcpTool] });
        captured.push(result.session);
        return result;
      },
    }),
  });
  const required = ["kady-child-runtime"].map((id) => ({ id, path: path.resolve(import.meta.dirname, "../pi-packages", id, "index.ts") }));
  const child = await factory.create({
    cwd: paths.sandbox, storage: { kind: "memory" }, ambientExtensions: false,
    extensionPaths: required.map((r) => r.path), requiredExtensions: required, hooks: [],
    noSkills: true, noContextFiles: true, ...(tools !== undefined ? { tools } : {}),
    runtime: { agent: "researcher", orchestratorSessionId: "parent", runId: "run" }, onExtensionError: (failure: { error: unknown }) => { throw failure.error; },
  }) as FixtureChildSession;
  return { child, factory, session: requireValue(captured[0]) };
}

const registered = (session: AgentSession) => session.getAllTools().map((tool) => tool.name);
const callable = (session: AgentSession) => session.getCallableToolNames();

/** MCP connects after session start; wait until the extension has registered it. */
async function waitLateRegistered(session: AgentSession) {
  await waitFor(() => {
    expect(session.extensionRunner.getAllRegisteredTools().some((tool) => tool.definition.name === LATE_MCP)).toBe(true);
  });
}

it("excludes both already-registered and late MCP tools a restricted child does not name", async () => {
  const { child, factory, session } = await createChild(["read", "notebook", "modal_submit", "add_pdf_annotation"]);
  try {
    // The early custom tool must be gone immediately, before any MCP connects.
    expect(registered(session)).not.toContain(EARLY_MCP);
    expect(callable(session)).not.toContain(EARLY_MCP);
    await waitLateRegistered(session);
    expect(registered(session)).not.toContain(LATE_MCP);
    expect(callable(session)).not.toContain(LATE_MCP);
    expect(registered(session)).not.toContain(EARLY_MCP);
  } finally { await child.dispose(); await factory.dispose(); }
}, 30_000);

it("keeps MCP tools the allowlist names (early and late)", async () => {
  const { child, factory, session } = await createChild(["read", EARLY_MCP, LATE_MCP]);
  try {
    expect(registered(session)).toContain(EARLY_MCP);
    await waitLateRegistered(session);
    expect(registered(session)).toContain(LATE_MCP);
  } finally { await child.dispose(); await factory.dispose(); }
}, 30_000);

it("keeps normal MCP for an unrestricted child (no allowlist)", async () => {
  const { child, factory, session } = await createChild();
  try {
    expect(registered(session)).toContain(EARLY_MCP);
    await waitLateRegistered(session);
    expect(registered(session)).toContain(LATE_MCP);
  } finally { await child.dispose(); await factory.dispose(); }
}, 30_000);

it("excludes all MCP for an empty allowlist (empty capability ceiling)", async () => {
  const { child, factory, session } = await createChild([]);
  try {
    expect(registered(session)).not.toContain(EARLY_MCP);
    await waitLateRegistered(session);
    expect(registered(session)).not.toContain(LATE_MCP);
  } finally { await child.dispose(); await factory.dispose(); }
}, 30_000);
