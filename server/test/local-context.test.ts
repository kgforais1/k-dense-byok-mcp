import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheKey,
  getContextWindow,
  probeArchitecturalOllama,
  probeLoaded,
  recordArchitectural,
  recordLoaded,
} from "../src/agent/local-context.ts";

// Everything here stubs `fetch` — no real network. Each test uses a fresh
// base URL so the module-level cache and dedup map cannot leak state between
// tests (the module exports no reset hook by design).
let n = 0;
const freshBase = () => `http://local-context-test-${++n}.invalid`;

function okJson(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}

function httpError(status = 404) {
  return { ok: false, status, json: async () => ({}) };
}

function malformed() {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("unexpected token");
    },
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => handler(String(url), init)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cacheKey", () => {
  it("strips trailing slashes from the base URL", () => {
    expect(cacheKey("ollama", "http://x:11434///", "m:latest")).toBe(
      cacheKey("ollama", "http://x:11434", "m:latest"),
    );
  });

  it("treats the model endpoint and the server root as the same key", () => {
    // Builders hold `<root>/v1`; probe endpoints live on the root. The key
    // uses the root form so a route write is found by a builder read.
    expect(cacheKey("ollama", "http://x:11434/v1", "m:latest")).toBe(
      cacheKey("ollama", "http://x:11434", "m:latest"),
    );
  });

  it("appends :latest to an untagged ollama id", () => {
    const base = freshBase();
    expect(cacheKey("ollama", base, "all-minilm")).toBe(
      cacheKey("ollama", base, "all-minilm:latest"),
    );
  });

  it("leaves a registry-qualified tagged ollama id alone", () => {
    const base = freshBase();
    const key = cacheKey("ollama", base, "hf.co/user/model:Q4_K_M");
    expect(key).toContain("hf.co/user/model:Q4_K_M");
    expect(key).not.toBe(cacheKey("ollama", base, "hf.co/user/model:Q4_K_M:latest"));
  });

  it("treats a registry port as untagged, not as a tag", () => {
    const base = freshBase();
    expect(cacheKey("ollama", base, "localhost:5000/foo")).toBe(
      cacheKey("ollama", base, "localhost:5000/foo:latest"),
    );
  });

  it("never appends :latest for openai-compatible", () => {
    const base = freshBase();
    const id = "qwen/qwen3.8-27b-mlx-6bit-xhigh";
    const key = cacheKey("openai-compatible", base, id);
    expect(key).toContain(id);
    expect(key.endsWith(":latest")).toBe(false);
  });
});

describe("getContextWindow / record*", () => {
  it("returns loaded ?? architectural", () => {
    const base = freshBase();
    const key = cacheKey("ollama", base, "m:latest");
    expect(getContextWindow("ollama", base, "m:latest")).toBeUndefined();
    recordArchitectural(key, 40960);
    expect(getContextWindow("ollama", base, "m:latest")).toBe(40960);
    recordLoaded(key, 8192);
    expect(getContextWindow("ollama", base, "m:latest")).toBe(8192);
  });

  it("recordLoaded(undefined) clears the loaded slot", () => {
    const base = freshBase();
    const key = cacheKey("ollama", base, "m:latest");
    recordArchitectural(key, 40960);
    recordLoaded(key, 8192);
    recordLoaded(key, undefined);
    expect(getContextWindow("ollama", base, "m:latest")).toBe(40960);
  });

  it("recordLoaded(undefined) on a missing key is a no-op", () => {
    const base = freshBase();
    const key = cacheKey("ollama", base, "never-seen:latest");
    expect(() => recordLoaded(key, undefined)).not.toThrow();
    expect(getContextWindow("ollama", base, "never-seen:latest")).toBeUndefined();
  });

  it("ignores non-positive-integer writes", () => {
    const base = freshBase();
    const key = cacheKey("ollama", base, "m:latest");
    for (const bad of [0, -5, 3.5, Number.NaN, undefined]) {
      recordArchitectural(key, bad);
      recordLoaded(key, bad);
    }
    expect(getContextWindow("ollama", base, "m:latest")).toBeUndefined();
    // A bad write never destroys a good entry either.
    recordArchitectural(key, 40960);
    recordLoaded(key, 8192);
    recordArchitectural(key, 0);
    recordLoaded(key, -1);
    expect(getContextWindow("ollama", base, "m:latest")).toBe(8192);
  });
});

describe("probeLoaded (ollama)", () => {
  const psPayload = {
    models: [{ name: "all-minilm:latest", context_length: 256 }],
  };

  // The probe fetches `/api/ps` only; the architectural figure is recorded
  // inline by the discovery route from the `/api/tags` payload it already
  // holds, so seed it the same way these tests' subjects will see it.
  function seedArchitectural(base: string, id: string, value: number) {
    recordArchitectural(cacheKey("ollama", base, id), value);
  }

  function stubOllama() {
    return stubFetch((url) => {
      if (url.endsWith("/api/ps")) return okJson(psPayload);
      throw new Error(`unexpected url ${url}`);
    });
  }

  it("writes both slots, and an untagged lookup hits the tagged write", async () => {
    const base = freshBase();
    const seen: string[] = [];
    seedArchitectural(base, "all-minilm", 512);
    stubFetch((url) => {
      seen.push(url);
      if (url.endsWith("/api/ps")) return okJson(psPayload);
      throw new Error(`unexpected url ${url}`);
    });
    await probeLoaded("ollama", base);
    // Probes hit the root, never the /v1 model endpoint, and never re-fetch
    // the tags payload the route already has.
    expect(seen).toEqual([`${base}/api/ps`]);
    expect(seen.every((u) => !u.includes("/v1/"))).toBe(true);
    // Loaded wins; clearing it reverts to architectural.
    expect(getContextWindow("ollama", base, "all-minilm")).toBe(256);
    expect(getContextWindow("ollama", base, "all-minilm:latest")).toBe(256);
    recordLoaded(cacheKey("ollama", base, "all-minilm"), undefined);
    expect(getContextWindow("ollama", base, "all-minilm")).toBe(512);
  });

  it("dedups concurrent callers into one set of fetches", async () => {
    const base = freshBase();
    stubOllama();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    await Promise.all([probeLoaded("ollama", base), probeLoaded("ollama", base)]);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.endsWith("/api/tags"))).toHaveLength(0);
    expect(urls.filter((u) => u.endsWith("/api/ps"))).toHaveLength(1);
    expect(getContextWindow("ollama", base, "all-minilm")).toBe(256);
  });

  it("resolves with no cache write on a closed port", async () => {
    const base = freshBase();
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await probeLoaded("ollama", base);
    expect(getContextWindow("ollama", base, "all-minilm")).toBeUndefined();
  });

  it("resolves with no cache write on a 404", async () => {
    const base = freshBase();
    stubFetch(() => httpError(404));
    await probeLoaded("ollama", base);
    expect(getContextWindow("ollama", base, "all-minilm")).toBeUndefined();
  });

  it("resolves with no cache write on a malformed body", async () => {
    const base = freshBase();
    stubFetch(() => malformed());
    await probeLoaded("ollama", base);
    expect(getContextWindow("ollama", base, "all-minilm")).toBeUndefined();
  });

  it("a failed refresh leaves a warm entry alone", async () => {
    const base = freshBase();
    seedArchitectural(base, "all-minilm", 512);
    stubOllama();
    await probeLoaded("ollama", base);
    expect(getContextWindow("ollama", base, "all-minilm")).toBe(256);
    stubFetch(() => httpError(404));
    await probeLoaded("ollama", base);
    expect(getContextWindow("ollama", base, "all-minilm")).toBe(256);
  });

  it("a successful loaded-probe clears an unreported model's loaded slot", async () => {
    const base = freshBase();
    seedArchitectural(base, "a", 8192);
    seedArchitectural(base, "b", 4096);
    recordLoaded(cacheKey("ollama", base, "a"), 8192);
    stubFetch(() => okJson({ models: [{ name: "b:latest", context_length: 2048 }] }));
    await probeLoaded("ollama", base);
    // `a` unloaded: loaded cleared, architectural intact. `b` keeps both.
    expect(getContextWindow("ollama", base, "a")).toBe(8192);
    expect(getContextWindow("ollama", base, "b")).toBe(2048);
  });

  it("a 200 whose rows all fail to parse clears nothing", async () => {
    // A malformed answer wearing a 200 must not look like "nothing loaded".
    // Clearing here would revert to the higher architectural figure and
    // over-declare, which is the failure direction this module exists to stop.
    const base = freshBase();
    seedArchitectural(base, "all-minilm", 512);
    stubOllama();
    await probeLoaded("ollama", base);
    expect(getContextWindow("ollama", base, "all-minilm")).toBe(256);
    stubFetch(() => okJson({ models: [{ no: "name" }] }));
    await probeLoaded("ollama", base);
    expect(getContextWindow("ollama", base, "all-minilm")).toBe(256);
  });

  it("one unreadable row forfeits the clear for the whole answer", async () => {
    // The partial case the all-rows-fail guard misses. `qwen3:8b` is loaded
    // and reported; the nameless row could be `all-minilm`, so we cannot
    // read its absence as "unloaded" and must leave its figure alone.
    const base = freshBase();
    seedArchitectural(base, "all-minilm", 512);
    stubOllama();
    await probeLoaded("ollama", base);
    expect(getContextWindow("ollama", base, "all-minilm")).toBe(256);
    stubFetch(() =>
      okJson({
        models: [{ name: "qwen3:8b", context_length: 40960 }, { no: "name" }],
      }),
    );
    await probeLoaded("ollama", base);
    expect(getContextWindow("ollama", base, "all-minilm")).toBe(256);
    expect(getContextWindow("ollama", base, "qwen3:8b")).toBe(40960);
  });

  it("keeps the old figure when a running model's context_length is unusable", async () => {
    // `/api/ps` lists only running models, so the row itself proves the model
    // is loaded. A missing or unusable `context_length` is absent metadata,
    // never evidence of an unload — clearing would over-declare.
    for (const bad of [undefined, "256", 0, -1, {}]) {
      const base = freshBase();
      seedArchitectural(base, "all-minilm", 512);
      stubOllama();
      await probeLoaded("ollama", base);
      expect(getContextWindow("ollama", base, "all-minilm")).toBe(256);
      stubFetch(() =>
        okJson({ models: [{ name: "all-minilm:latest", context_length: bad }] }),
      );
      await probeLoaded("ollama", base);
      expect(getContextWindow("ollama", base, "all-minilm")).toBe(256);
    }
  });

  it("a whitespace-only name forfeits the clear, like any unreadable row", async () => {
    // The probe's name predicate must match the discovery route's. If it
    // accepted "   ", the row would join `reported` under a key nothing else
    // ever writes, the snapshot would look complete, and all-minilm's real
    // loaded figure would be cleared in favour of the higher architectural
    // one.
    const base = freshBase();
    seedArchitectural(base, "all-minilm", 512);
    stubOllama();
    await probeLoaded("ollama", base);
    expect(getContextWindow("ollama", base, "all-minilm")).toBe(256);
    stubFetch(() => okJson({ models: [{ name: "   ", context_length: 4096 }] }));
    await probeLoaded("ollama", base);
    expect(getContextWindow("ollama", base, "all-minilm")).toBe(256);
  });

  it("a genuinely empty /api/ps still clears, because nothing is loaded", async () => {
    const base = freshBase();
    seedArchitectural(base, "all-minilm", 512);
    stubOllama();
    await probeLoaded("ollama", base);
    expect(getContextWindow("ollama", base, "all-minilm")).toBe(256);
    stubFetch(() => okJson({ models: [] }));
    await probeLoaded("ollama", base);
    expect(getContextWindow("ollama", base, "all-minilm")).toBe(512);
  });

  it("a failed loaded-probe clears nothing", async () => {
    const base = freshBase();
    seedArchitectural(base, "all-minilm", 512);
    stubOllama();
    await probeLoaded("ollama", base);
    expect(getContextWindow("ollama", base, "all-minilm")).toBe(256);
    // /api/ps fails. The warm loaded figure survives rather than reverting.
    stubFetch(() => httpError(500));
    await probeLoaded("ollama", base);
    expect(getContextWindow("ollama", base, "all-minilm")).toBe(256);
  });
});

describe("probeArchitecturalOllama", () => {
  // The `/api/show` fallback for rows whose `/api/tags` entry carried no
  // `details.context_length`. Only the missing rows are asked about, and the
  // answer's key is architecture-prefixed rather than fixed.
  function showBody(info: Record<string, unknown>) {
    return okJson({ model_info: info });
  }

  function stubShow(
    handler: (modelId: string) => unknown,
    seen?: { url: string; model: unknown }[],
  ) {
    stubFetch((url, init) => {
      if (!url.endsWith("/api/show")) throw new Error(`unexpected url ${url}`);
      const model = JSON.parse(String(init?.body)).model as string;
      seen?.push({ url, model });
      return handler(model);
    });
  }

  it("reads the figure under the architecture-prefixed key", async () => {
    const base = freshBase();
    const seen: { url: string; model: unknown }[] = [];
    stubShow(
      () =>
        showBody({
          "general.architecture": "qwen3",
          "qwen3.context_length": 40960,
          "qwen3.embedding_length": 2560,
        }),
      seen,
    );
    await probeArchitecturalOllama(base, [{ id: "qwen3:8b" }]);
    // POSTed to the root, naming the model as `/api/show` documents.
    expect(seen).toEqual([{ url: `${base}/api/show`, model: "qwen3:8b" }]);
    expect(getContextWindow("ollama", base, "qwen3:8b")).toBe(40960);
  });

  it("falls back to a lone *.context_length key when the architecture is absent", async () => {
    const base = freshBase();
    stubShow(() => showBody({ "llama.context_length": 131072 }));
    await probeArchitecturalOllama(base, [{ id: "llama3:8b" }]);
    expect(getContextWindow("ollama", base, "llama3:8b")).toBe(131072);
  });

  it("records nothing when several keys could be the one", async () => {
    const base = freshBase();
    stubShow(() =>
      showBody({
        "llama.context_length": 131072,
        "clip.context_length": 512,
      }),
    );
    await probeArchitecturalOllama(base, [{ id: "llava:7b" }]);
    // Ambiguity leaves the slot empty rather than picking: a wrong pick here
    // over-declares the window.
    expect(getContextWindow("ollama", base, "llava:7b")).toBeUndefined();
  });

  it("records nothing on a 404, a malformed body or an unusable value", async () => {
    const base = freshBase();
    stubShow((model) => {
      if (model === "gone:latest") return httpError();
      if (model === "garbage:latest") return malformed();
      return showBody({
        "general.architecture": "llama",
        "llama.context_length": 0,
      });
    });
    await probeArchitecturalOllama(base, [
      { id: "gone:latest" },
      { id: "garbage:latest" },
      { id: "zero:latest" },
    ]);
    for (const id of ["gone:latest", "garbage:latest", "zero:latest"]) {
      expect(getContextWindow("ollama", base, id)).toBeUndefined();
    }
  });

  it("one model's failure does not abandon the rest of the queue", async () => {
    const base = freshBase();
    stubFetch((url, init) => {
      if (!url.endsWith("/api/show")) throw new Error(`unexpected url ${url}`);
      const model = JSON.parse(String(init?.body)).model as string;
      if (model === "boom:latest") throw new TypeError("fetch failed");
      return okJson({
        model_info: { "general.architecture": "llama", "llama.context_length": 8192 },
      });
    });
    await probeArchitecturalOllama(base, [{ id: "boom:latest" }, { id: "ok:latest" }]);
    expect(getContextWindow("ollama", base, "boom:latest")).toBeUndefined();
    expect(getContextWindow("ollama", base, "ok:latest")).toBe(8192);
  });

  it("skips a model whose figure is already cached, and duplicates in one batch", async () => {
    const base = freshBase();
    const seen: { url: string; model: unknown }[] = [];
    recordArchitectural(cacheKey("ollama", base, "known:latest"), 4096);
    stubShow(
      () =>
        showBody({ "general.architecture": "llama", "llama.context_length": 8192 }),
      seen,
    );
    await probeArchitecturalOllama(base, [
      { id: "known:latest" },
      { id: "new:latest" },
      { id: "new:latest" },
    ]);
    expect(seen.map((s) => s.model)).toEqual(["new:latest"]);
    // The cached figure is untouched, not refreshed.
    expect(getContextWindow("ollama", base, "known:latest")).toBe(4096);
  });

  it("dedups overlapping batches and never runs more than four at once", async () => {
    const base = freshBase();
    let live = 0;
    let peak = 0;
    const models = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}:latest` }));
    const calls: string[] = [];
    stubFetch(async (url, init) => {
      if (!url.endsWith("/api/show")) throw new Error(`unexpected url ${url}`);
      calls.push(JSON.parse(String(init?.body)).model as string);
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return okJson({
        model_info: { "general.architecture": "llama", "llama.context_length": 8192 },
      });
    });
    await Promise.all([
      probeArchitecturalOllama(base, models),
      probeArchitecturalOllama(base, models),
    ]);
    // A second open while the first is still running adds no calls.
    expect(calls).toHaveLength(models.length);
    expect(peak).toBeLessThanOrEqual(4);
    expect(getContextWindow("ollama", base, "m11:latest")).toBe(8192);
  });

  it("re-asks when the digest changes, and not otherwise", async () => {
    const base = freshBase();
    const seen: { url: string; model: unknown }[] = [];
    let answer = 40960;
    stubShow(
      () =>
        showBody({
          "general.architecture": "qwen3",
          "qwen3.context_length": answer,
        }),
      seen,
    );
    await probeArchitecturalOllama(base, [{ id: "q:latest", digest: "sha256:aaa" }]);
    expect(getContextWindow("ollama", base, "q:latest")).toBe(40960);

    // Same pull, so the answer we hold still describes this model.
    await probeArchitecturalOllama(base, [{ id: "q:latest", digest: "sha256:aaa" }]);
    expect(seen).toHaveLength(1);

    // Re-pulled under the same name: the tag now points at a different model,
    // and keeping the old figure would over-declare a smaller one.
    answer = 8192;
    await probeArchitecturalOllama(base, [{ id: "q:latest", digest: "sha256:bbb" }]);
    expect(seen).toHaveLength(2);
    expect(getContextWindow("ollama", base, "q:latest")).toBe(8192);
  });

  it("leaves a tags-sourced figure alone even as the digest moves", async () => {
    const base = freshBase();
    const seen: { url: string; model: unknown }[] = [];
    // What the discovery route writes inline from the /api/tags payload. That
    // path rewrites the figure on every open, so it is current by
    // construction and owes no call at any digest.
    recordArchitectural(cacheKey("ollama", base, "q:latest"), 4096);
    stubShow(() => showBody({ "llama.context_length": 8192 }), seen);
    await probeArchitecturalOllama(base, [{ id: "q:latest", digest: "sha256:aaa" }]);
    await probeArchitecturalOllama(base, [{ id: "q:latest", digest: "sha256:bbb" }]);
    expect(seen).toEqual([]);
    expect(getContextWindow("ollama", base, "q:latest")).toBe(4096);
  });

  it("asks about a row whose figure arrived present but unusable", async () => {
    const base = freshBase();
    const seen: { url: string; model: unknown }[] = [];
    // `recordArchitectural` rejects a non-positive integer, so the slot is
    // empty even though the row carried a number. A caller filtering on
    // "the field was undefined" would skip this one and leave the model on
    // the 128,000 floor, over-declaring it.
    recordArchitectural(cacheKey("ollama", base, "zero:latest"), 0);
    recordArchitectural(cacheKey("ollama", base, "negative:latest"), -1);
    recordArchitectural(cacheKey("ollama", base, "fraction:latest"), 1.5);
    stubShow(
      () =>
        showBody({ "general.architecture": "llama", "llama.context_length": 8192 }),
      seen,
    );
    await probeArchitecturalOllama(base, [
      { id: "zero:latest" },
      { id: "negative:latest" },
      { id: "fraction:latest" },
    ]);
    expect(seen.map((s) => s.model)).toEqual([
      "zero:latest",
      "negative:latest",
      "fraction:latest",
    ]);
  });

  it("caps concurrency across calls, not per call", async () => {
    const base = freshBase();
    let live = 0;
    let peak = 0;
    stubFetch(async (url, init) => {
      if (!url.endsWith("/api/show")) throw new Error(`unexpected url ${url}`);
      void init;
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return okJson({
        model_info: { "general.architecture": "llama", "llama.context_length": 8192 },
      });
    });
    // Disjoint sets, so the in-flight check dedups nothing between them. A
    // per-call pool would run eight at once here.
    await Promise.all([
      probeArchitecturalOllama(
        base,
        Array.from({ length: 8 }, (_, i) => ({ id: `a${i}:latest` })),
      ),
      probeArchitecturalOllama(
        base,
        Array.from({ length: 8 }, (_, i) => ({ id: `b${i}:latest` })),
      ),
    ]);
    expect(peak).toBeLessThanOrEqual(4);
    // Both calls resolve only once their own models are done.
    expect(getContextWindow("ollama", base, "a7:latest")).toBe(8192);
    expect(getContextWindow("ollama", base, "b7:latest")).toBe(8192);
  });

  it("retries a model /api/show could not answer for", async () => {
    const base = freshBase();
    let attempts = 0;
    stubShow(() => {
      attempts += 1;
      return attempts === 1
        ? httpError()
        : showBody({ "general.architecture": "llama", "llama.context_length": 8192 });
    });
    await probeArchitecturalOllama(base, [{ id: "flaky:latest", digest: "sha256:a" }]);
    expect(getContextWindow("ollama", base, "flaky:latest")).toBeUndefined();
    // Same digest, but we still hold no figure — remembering the failure
    // would make a transient one permanent.
    await probeArchitecturalOllama(base, [{ id: "flaky:latest", digest: "sha256:a" }]);
    expect(attempts).toBe(2);
    expect(getContextWindow("ollama", base, "flaky:latest")).toBe(8192);
  });

  it("does nothing, and makes no call, for an empty list", async () => {
    const base = freshBase();
    stubFetch((url) => {
      throw new Error(`unexpected url ${url}`);
    });
    await expect(probeArchitecturalOllama(base, [])).resolves.toBeUndefined();
  });
});

describe("probeLoaded (openai-compatible)", () => {
  const v0Payload = {
    data: [
      {
        id: "allenai/olmocr-2-7b",
        max_context_length: 128000,
        loaded_context_length: 64000,
      },
      { id: "qwen/qwen3-8b", max_context_length: 32768 },
    ],
  };

  it("writes both slots, prefers loaded, never skips an unloaded entry", async () => {
    const base = freshBase();
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return okJson(v0Payload);
    });
    await probeLoaded("openai-compatible", base);
    expect(seen).toEqual([`${base}/api/v0/models`]);
    expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBe(64000);
    // Listed but not loaded: architectural figure recorded regardless.
    expect(getContextWindow("openai-compatible", base, "qwen/qwen3-8b")).toBe(32768);
    recordLoaded(
      cacheKey("openai-compatible", base, "allenai/olmocr-2-7b"),
      undefined,
    );
    expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBe(128000);
  });

  it("a 200 whose rows all fail to parse clears nothing", async () => {
    // Same invariant as the ollama side: a malformed 200 must not be read as
    // "nothing loaded", because reverting to the architectural figure
    // over-declares.
    const base = freshBase();
    stubFetch(() => okJson(v0Payload));
    await probeLoaded("openai-compatible", base);
    expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBe(64000);
    stubFetch(() => okJson({ data: [{}] }));
    await probeLoaded("openai-compatible", base);
    expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBe(64000);
  });

  it("one unreadable row forfeits the clear for the whole answer", async () => {
    // Same partial-snapshot rule as the ollama side.
    const base = freshBase();
    stubFetch(() => okJson(v0Payload));
    await probeLoaded("openai-compatible", base);
    expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBe(64000);
    stubFetch(() =>
      okJson({ data: [{ id: "qwen/qwen3-8b", max_context_length: 32768 }, {}] }),
    );
    await probeLoaded("openai-compatible", base);
    expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBe(64000);
  });

  it("a present but unreadable loaded_context_length keeps the old figure", async () => {
    // Present-but-unusable means we learned nothing. Clearing on it would
    // revert to the higher architectural figure and over-declare.
    for (const bad of ["65536", 0, -1, 4096.5, {}]) {
      const base = freshBase();
      stubFetch(() => okJson(v0Payload));
      await probeLoaded("openai-compatible", base);
      expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBe(64000);
      stubFetch(() =>
        okJson({
          data: [
            {
              id: "allenai/olmocr-2-7b",
              max_context_length: 128000,
              loaded_context_length: bad,
            },
          ],
        }),
      );
      await probeLoaded("openai-compatible", base);
      expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBe(64000);
    }
  });

  it("keeps the first of a duplicated id, as the discovery route does", async () => {
    // The route skips an id it has already seen, so the row the user picks is
    // built from the first occurrence. The cached figure has to agree.
    const base = freshBase();
    stubFetch(() =>
      okJson({
        data: [
          { id: "dupe", max_context_length: 8192, loaded_context_length: 4096 },
          { id: "dupe", max_context_length: 65536, loaded_context_length: 32768 },
        ],
      }),
    );
    await probeLoaded("openai-compatible", base);
    expect(getContextWindow("openai-compatible", base, "dupe")).toBe(4096);
  });

  it("a whitespace-only id forfeits the clear, like any unreadable row", async () => {
    const base = freshBase();
    stubFetch(() => okJson(v0Payload));
    await probeLoaded("openai-compatible", base);
    expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBe(64000);
    stubFetch(() => okJson({ data: [{ id: "   ", max_context_length: 8192 }] }));
    await probeLoaded("openai-compatible", base);
    expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBe(64000);
  });

  it("a null loaded_context_length reads as absent, so it clears", async () => {
    // LM Studio omits the field when a model is unloaded, but a server that
    // sends an explicit null means the same thing.
    const base = freshBase();
    stubFetch(() => okJson(v0Payload));
    await probeLoaded("openai-compatible", base);
    expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBe(64000);
    stubFetch(() =>
      okJson({
        data: [
          {
            id: "allenai/olmocr-2-7b",
            max_context_length: 128000,
            loaded_context_length: null,
          },
        ],
      }),
    );
    await probeLoaded("openai-compatible", base);
    expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBe(128000);
  });

  it("a listed-but-unloaded entry reverts a stale loaded slot", async () => {
    const base = freshBase();
    stubFetch(() => okJson(v0Payload));
    await probeLoaded("openai-compatible", base);
    expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBe(64000);
    // Model unloads: still listed, loaded figure gone.
    stubFetch(() =>
      okJson({
        data: [{ id: "allenai/olmocr-2-7b", max_context_length: 128000 }],
      }),
    );
    await probeLoaded("openai-compatible", base);
    expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBe(128000);
  });

  it("dedups concurrent callers into a single fetch", async () => {
    const base = freshBase();
    stubFetch(() => okJson(v0Payload));
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    await Promise.all([
      probeLoaded("openai-compatible", base),
      probeLoaded("openai-compatible", base),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves with no cache write on failure modes", async () => {
    for (const handler of [
      () => {
        throw new TypeError("fetch failed");
      },
      () => httpError(404),
      () => malformed(),
      () => okJson({ data: "not-an-array" }),
    ]) {
      const base = freshBase();
      stubFetch(handler);
      await probeLoaded("openai-compatible", base);
      expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBeUndefined();
    }
  });

  it("a failed refresh leaves a warm entry alone", async () => {
    const base = freshBase();
    stubFetch(() => okJson(v0Payload));
    await probeLoaded("openai-compatible", base);
    stubFetch(() => httpError(404));
    await probeLoaded("openai-compatible", base);
    expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBe(64000);
  });

  it("times out instead of hanging, and the dedup map is usable afterwards", async () => {
    const base = freshBase();
    stubFetch((_url, init) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    const start = Date.now();
    await probeLoaded("openai-compatible", base);
    // It waited out (roughly) the 2 s timeout rather than returning instantly.
    expect(Date.now() - start).toBeGreaterThan(1500);
    expect(
      getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b"),
    ).toBeUndefined();
    // A wedged dedup entry would join the old settled promise and never fetch;
    // a cleared one probes again and fills the cache.
    stubFetch(() => okJson(v0Payload));
    await probeLoaded("openai-compatible", base);
    expect(getContextWindow("openai-compatible", base, "allenai/olmocr-2-7b")).toBe(64000);
  }, 15000);
});
