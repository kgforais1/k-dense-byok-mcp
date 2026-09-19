import { describe, expect, it } from "vitest";
import {
  assertModelAuthentication,
  catalogueEntryFor,
  ModelAuthenticationError,
  ModelResolutionError,
  modelReference,
  resolveModel,
} from "../src/agent/models.ts";
import { getModelRegistry } from "../src/agent/session-registry.ts";
import {
  cacheKey,
  recordArchitectural,
  recordLoaded,
} from "../src/agent/local-context.ts";
import {
  OLLAMA_BASE_URL,
  OPENAI_COMPATIBLE_BASE_URL,
} from "../src/config.ts";

// Reasoning-effort suffixes ("...-xhigh", "...-high", …) are an OpenRouter
// routing form, not separate catalogue rows. Before the fix they missed the
// catalogue and resolved to $0 cost — silently disabling the project spend cap
// (this is why the opus-4.8-xhigh default's spend wasn't capped).
describe("catalogueEntryFor (reasoning-effort suffix pricing)", () => {
  it("prices a reasoning-effort-suffixed id as its base model (not $0)", () => {
    const base = catalogueEntryFor("anthropic/claude-opus-4.8");
    const xhigh = catalogueEntryFor("anthropic/claude-opus-4.8-xhigh");
    expect(base).toBeDefined();
    expect(xhigh).toBeDefined();
    expect(xhigh!.costInput).toBe(base!.costInput);
    expect(xhigh!.costOutput).toBe(base!.costOutput);
    expect(xhigh!.costInput).toBeGreaterThan(0);
  });

  it("does NOT strip -fast (a distinct catalogue model with its own pricing)", () => {
    // -fast is its own (pricier) model, not a reasoning-effort suffix, so it
    // must never collapse to the base row. The Anthropic -fast variants have
    // been delisted from OpenRouter, so a correct lookup finds nothing; a
    // suffix-stripping one would wrongly return `base`. Tolerate a relisting
    // as long as the pricing stays distinct.
    const base = catalogueEntryFor("anthropic/claude-opus-5");
    expect(base).toBeDefined();
    const fast = catalogueEntryFor("anthropic/claude-opus-5-fast");
    expect(fast === undefined || fast.costInput !== base!.costInput).toBe(true);
  });

  it("returns undefined for an unknown model", () => {
    expect(catalogueEntryFor("nonexistent/model-xyz")).toBeUndefined();
  });
});

describe("provider-aware model resolution", () => {
  const registry = getModelRegistry();

  it.each([
    ["anthropic/claude-opus-4-8", "anthropic"],
    ["openai-codex/gpt-5.6-sol", "openai-codex"],
    ["github-copilot/claude-sonnet-5", "github-copilot"],
    ["xai/grok-4.5", "xai"],
  ])("resolves %s through its direct Pi provider", (ref, provider) => {
    const model = resolveModel(ref, registry);
    expect(model.provider).toBe(provider);
    expect(modelReference(model)).toBe(ref);
  });

  it("keeps canonical and legacy OpenRouter refs on OpenRouter", () => {
    expect(
      resolveModel("openrouter/anthropic/claude-opus-4.8", registry).provider,
    ).toBe("openrouter");
    expect(resolveModel("meta-llama/llama-3.3-70b-instruct", registry).provider).toBe(
      "openrouter",
    );
  });

  it("refuses unknown direct-provider models instead of synthesizing OpenRouter", () => {
    expect(() =>
      resolveModel("anthropic/not-a-real-subscription-model", registry),
    ).toThrowError(ModelResolutionError);
  });

  it("requires OAuth rather than an ambient token for OAuth-only providers", async () => {
    // Anthropic/xAI now take an API key too (provider-catalog.ts); Copilot is
    // OAuth-only, so its COPILOT_GITHUB_TOKEN must not pass as a subscription.
    const model = resolveModel("github-copilot/claude-sonnet-5", registry);
    const apiKeyRuntime = {
      checkAuth: async () => ({ type: "api_key" as const, source: "COPILOT_GITHUB_TOKEN" }),
    };
    await expect(
      assertModelAuthentication(
        model,
        apiKeyRuntime as Parameters<typeof assertModelAuthentication>[1],
      ),
    ).rejects.toBeInstanceOf(ModelAuthenticationError);

    const oauthRuntime = {
      checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
    };
    await expect(
      assertModelAuthentication(
        model,
        oauthRuntime as Parameters<typeof assertModelAuthentication>[1],
      ),
    ).resolves.toBeUndefined();
  });
});

describe("custom model servers in ref resolution", () => {
  it("resolves <custom-id>/<model> through the registry and errors on unknown ids", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { KADY_PI_AGENT_DIR } = await import("../src/config.ts");
    const { writeCustomProviders } = await import("../src/agent/custom-models.ts");
    writeCustomProviders(
      [{ id: "hpc-vllm", baseUrl: "http://gpu:8000/v1", api: "openai-completions", models: [{ id: "llama-3.3-70b" }] }],
      KADY_PI_AGENT_DIR,
    );
    try {
      const found = { id: "llama-3.3-70b", provider: "hpc-vllm", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const registry = { find: (provider: string, id: string) => (provider === "hpc-vllm" && id === "llama-3.3-70b" ? found : null) } as never;
      expect(resolveModel("hpc-vllm/llama-3.3-70b", registry)).toBe(found);
      expect(() => resolveModel("hpc-vllm/not-listed", registry)).toThrow(ModelResolutionError);
      expect(() => resolveModel("hpc-vllm/not-listed", registry)).toThrow(/Unknown hpc-vllm model/);
      // Unknown prefixes that are not custom providers keep the legacy OpenRouter fallback.
      expect(modelReference(resolveModel("meta-llama/llama-3.3-70b", registry))).toBe("openrouter/meta-llama/llama-3.3-70b");
    } finally {
      fs.rmSync(path.join(KADY_PI_AGENT_DIR, "models.json"), { force: true });
      fs.rmSync(path.join(KADY_PI_AGENT_DIR, "kady-custom-models.json"), { force: true });
    }
  });
});

// Local-model builders read the `local-context.ts` cache (filled by the
// discovery routes) and fall back to 128_000 on a cold cache. State is seeded
// with `recordArchitectural` / `recordLoaded` under `cacheKey`, never by
// stubbing fetch — the builders only ever see the bare id `resolveModel`
// hands them, so each test seeds the key the builder will look up. Model ids
// are unique per test because the cache is module-level with no reset hook.
describe("local-model context window (cache-backed builders)", () => {
  const registry = getModelRegistry();

  it("falls back to 128_000 with a cold cache", () => {
    expect(
      resolveModel("ollama/ctx-test-cold-ollama-xyz", registry).contextWindow,
    ).toBe(128_000);
    expect(
      resolveModel("openai-compatible/ctx-test-cold-compat-xyz", registry)
        .contextWindow,
    ).toBe(128_000);
  });

  it("returns the cached architectural figure when warm", () => {
    recordArchitectural(
      cacheKey("ollama", OLLAMA_BASE_URL, "ctx-test-warm-ollama-xyz:latest"),
      40_960,
    );
    expect(
      resolveModel("ollama/ctx-test-warm-ollama-xyz:latest", registry)
        .contextWindow,
    ).toBe(40_960);

    recordArchitectural(
      cacheKey(
        "openai-compatible",
        OPENAI_COMPATIBLE_BASE_URL,
        "ctx-test-vendor/ctx-test-warm-compat-xyz",
      ),
      64_000,
    );
    expect(
      resolveModel(
        "openai-compatible/ctx-test-vendor/ctx-test-warm-compat-xyz",
        registry,
      ).contextWindow,
    ).toBe(64_000);
  });

  it("prefers the loaded figure over the architectural one", () => {
    const ollamaKey = cacheKey(
      "ollama",
      OLLAMA_BASE_URL,
      "ctx-test-loaded-ollama-xyz:latest",
    );
    recordArchitectural(ollamaKey, 40_960);
    recordLoaded(ollamaKey, 8192);
    expect(
      resolveModel("ollama/ctx-test-loaded-ollama-xyz:latest", registry)
        .contextWindow,
    ).toBe(8192);

    const compatKey = cacheKey(
      "openai-compatible",
      OPENAI_COMPATIBLE_BASE_URL,
      "ctx-test-vendor/ctx-test-loaded-compat-xyz",
    );
    recordArchitectural(compatKey, 128_000);
    recordLoaded(compatKey, 64_000);
    expect(
      resolveModel(
        "openai-compatible/ctx-test-vendor/ctx-test-loaded-compat-xyz",
        registry,
      ).contextWindow,
    ).toBe(64_000);
  });

  it("resolves an untagged Ollama id to its canonical tagged entry", () => {
    // The discovery route writes the tagged key (`/api/tags` only ever
    // reports `all-minilm:latest`), while a ref that omits the tag resolves
    // to a bare id — without the `:latest` normalisation that run would miss
    // the cache forever and sit silently on the fallback.
    recordArchitectural(
      cacheKey("ollama", OLLAMA_BASE_URL, "ctx-test-untagged-xyz:latest"),
      32_768,
    );
    expect(cacheKey("ollama", OLLAMA_BASE_URL, "ctx-test-untagged-xyz")).toBe(
      cacheKey("ollama", OLLAMA_BASE_URL, "ctx-test-untagged-xyz:latest"),
    );
    expect(
      resolveModel("ollama/ctx-test-untagged-xyz", registry).contextWindow,
    ).toBe(32_768);
  });

  it("does not apply :latest normalisation to openai-compatible ids", () => {
    // LM Studio ids routinely carry no colon at all
    // (`qwen/qwen3.8-27b-mlx-6bit-xhigh`), so the Ollama tagging rule would
    // retag every id and break every key here.
    const id = "qwen/ctx-test-notag-compat-xyz";
    recordArchitectural(
      cacheKey("openai-compatible", OPENAI_COMPATIBLE_BASE_URL, id),
      96_000,
    );
    expect(
      resolveModel(`openai-compatible/${id}`, registry).contextWindow,
    ).toBe(96_000);
    // A `:latest`-suffixed lookup is a different model, not the same entry —
    // if the tagging rule leaked across providers, this would hit the entry
    // above instead of falling back.
    expect(
      resolveModel(`openai-compatible/${id}:latest`, registry).contextWindow,
    ).toBe(128_000);
  });
});
