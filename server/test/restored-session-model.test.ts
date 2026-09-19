import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getModelRegistry,
  getModelRuntime,
  lastModelInSessionFile,
  persistedModel,
} from "../src/agent/session-registry.ts";

/**
 * Reopening a session must bring back the model it was running, and a local
 * model is the case that used to fail.
 *
 * Pi's registry holds no entry for one — the runtime is created with
 * `allowModelNetwork: false` and `ollama` / `openai-compatible` are registered
 * with an empty model list — so the restore lookup returned `undefined` and the
 * caller fell through to the configured default, normally an OpenRouter model.
 * The browser hid it by sending `model` on every run, but the MCP tool
 * documents `model` as "defaults to the session's current model", and that path
 * therefore billed a cloud provider for a chat the user had pinned to hardware
 * in the room with them.
 */
describe("restoring the model a session last ran with", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  /** A transcript whose last model_change names `provider`/`modelId`. */
  function sessionFile(provider: string, modelId: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-restore-"));
    dirs.push(dir);
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
        JSON.stringify({ type: "model_change", provider, modelId }),
        "",
      ].join("\n"),
    );
    return file;
  }

  const resolve = (provider: string, modelId: string) =>
    persistedModel(getModelRuntime(), getModelRegistry(), provider, modelId);

  it.each([
    ["ollama", "qwen3:0.6b"],
    ["openai-compatible", "qwen/qwen3-8b"],
  ])("restores a %s model the runtime has no registry entry for", (provider, modelId) => {
    // The precondition the bug rested on. If Pi ever does start listing local
    // models, this stops being vacuous rather than silently testing nothing.
    expect(getModelRuntime().getModel(provider, modelId)).toBeUndefined();

    const model = resolve(provider, modelId);

    expect(model?.provider).toBe(provider);
    expect(model?.id).toBe(modelId);
  });

  it("reads the local model back out of a real transcript", () => {
    const last = lastModelInSessionFile(sessionFile("ollama", "qwen3:0.6b"));

    expect(last).toEqual({ provider: "ollama", modelId: "qwen3:0.6b" });
    expect(resolve(last!.provider, last!.modelId)?.id).toBe("qwen3:0.6b");
  });

  it("keeps an id containing slashes whole", () => {
    // LM Studio ids are vendor-prefixed, so a restore that split on the first
    // slash would resolve a different model than the session ran.
    expect(resolve("openai-compatible", "qwen/qwen3-8b")?.id).toBe("qwen/qwen3-8b");
  });

  it("does not resolve a local ref with no model id", () => {
    expect(resolve("ollama", "")).toBeUndefined();
    expect(resolve("ollama", "   ")).toBeUndefined();
  });

  it("leaves non-local providers to the runtime, and local ones alone", () => {
    // The guard that keeps this narrow. `resolveModel`'s trailing branch reads
    // an unrecognised prefix as an OpenRouter vendor id, so routing every
    // persisted ref through it would turn a provider Pi had dropped into a
    // billable cloud model — the same defect one step further on. A stub
    // runtime, so this asserts who is asked rather than what happens to be
    // installed.
    const asked: [string, string][] = [];
    const runtime = {
      getModel: (provider: string, modelId: string) => {
        asked.push([provider, modelId]);
        return undefined;
      },
    } as unknown as ReturnType<typeof getModelRuntime>;

    expect(
      persistedModel(runtime, getModelRegistry(), "openrouter", "some/model"),
    ).toBeUndefined();
    expect(asked).toEqual([["openrouter", "some/model"]]);

    // A local ref never consults the registry-backed lookup at all.
    expect(
      persistedModel(runtime, getModelRegistry(), "ollama", "qwen3:0.6b")?.id,
    ).toBe("qwen3:0.6b");
    expect(asked).toHaveLength(1);
  });
});
