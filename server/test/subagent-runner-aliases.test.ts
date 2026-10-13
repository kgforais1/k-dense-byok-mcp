/**
 * pi-subagents 0.78 marks `@earendil-works/pi-agent-core/node` optional.
 * Pi 1.0 dropped that export, and 0.74 treated the missing alias as fatal,
 * so every background launch failed. 0.78 skips an optional subpath the
 * installed package does not declare, for every host, and still fails when
 * a declared alias cannot be resolved.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { patchSubagents } from "../scripts/patch-subagents.mjs";
import { subagentsPackageDir } from "../src/agent/agent-files.ts";

patchSubagents();

const piPackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "..",
);
const { resolveHostPeerAliases } = await import(
  pathToFileURL(path.join(subagentsPackageDir(), "src/runs/background/runner-aliases.js")).href
);
const CORE_NODE = "@earendil-works/pi-agent-core/node";
const hostModule = process.env.KADY_SUBAGENT_HOST_MODULE;

afterEach(() => {
  if (hostModule === undefined) delete process.env.KADY_SUBAGENT_HOST_MODULE;
  else process.env.KADY_SUBAGENT_HOST_MODULE = hostModule;
});

describe("background runner host aliases", () => {
  it("resolves every alias the installed Pi still provides", () => {
    for (const hosted of [true, false]) {
      if (hosted) process.env.KADY_SUBAGENT_HOST_MODULE = "file:///kady-host.mjs";
      else delete process.env.KADY_SUBAGENT_HOST_MODULE;
      const { aliases, missing } = resolveHostPeerAliases(piPackageRoot);
      expect(missing).toEqual([]);
      expect(aliases["@earendil-works/pi-coding-agent"]).toBeTruthy();
      expect(aliases["@earendil-works/pi-agent-core"]).toBeTruthy();
      expect(aliases).not.toHaveProperty(CORE_NODE);
    }
  });
});
