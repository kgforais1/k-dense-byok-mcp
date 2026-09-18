import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

// GET /ollama/models: /api/tags serves the list and the architectural figure
// (`details.context_length`) inline, and one unawaited /api/ps call follows
// for the loaded figures — two calls per picker open, never one per model.
// No Ollama route test file existed before this chunk; the harness below
// mirrors openai-compatible.test.ts (fake http server, per-test module
// reload with the base URL pointed at it).

describe("GET /ollama/models", () => {
  let server: http.Server;
  let baseUrl: string;
  /** Serves `/api/tags`; set by each test. */
  let respondTags: (res: http.ServerResponse) => void;
  /** Serves the `/api/ps` loaded-figures probe; defaults to 404. */
  let respondPs: (res: http.ServerResponse) => void;
  let requestedPaths: string[];

  function okJson(res: http.ServerResponse, payload: unknown) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  }

  beforeEach(async () => {
    requestedPaths = [];
    respondTags = (res) => okJson(res, { models: [] });
    respondPs = (res) => {
      res.writeHead(404);
      res.end("nope");
    };
    server = http.createServer((req, res) => {
      const url = req.url ?? "";
      requestedPaths.push(url);
      if (url.startsWith("/api/ps")) respondPs(res);
      else if (url.startsWith("/api/tags")) respondTags(res);
      else {
        res.writeHead(404);
        res.end("nope");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * config.ts reads the environment once at import, so the route has to be
   * loaded fresh per test with the base URL already pointing at the fake server.
   */
  async function buildRoutes(envBaseUrl: string) {
    vi.resetModules();
    vi.stubEnv("OLLAMA_BASE_URL", envBaseUrl);
    const { registerSystemRoutes } = await import("../src/api/system.ts");
    const app = Fastify();
    await registerSystemRoutes(app);
    return app;
  }

  /** Re-opens the picker until the rows satisfy the predicate. The loaded
   * probe fires unawaited after the list is served, so the first open can
   * only ever carry the architectural figure. */
  async function waitForModels(
    app: Pick<Awaited<ReturnType<typeof buildRoutes>>, "inject">,
    predicate: (models: { context_length: number }[]) => boolean,
  ): Promise<{ models: { context_length: number }[] }> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const body = (await app.inject({ url: "/ollama/models" })).json();
      if (predicate(body.models)) return body;
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for the loaded probe to land");
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it("maps /api/tags into the picker shape with the architectural figure on the first open", async () => {
    respondTags = (res) =>
      okJson(res, {
        models: [
          { name: "all-minilm:latest", details: { context_length: 512 } },
          { name: "qwen3:8b", details: { context_length: 40960 } },
        ],
      });
    const app = await buildRoutes(baseUrl);

    // Unlike LM Studio, Ollama needs no second open: the architectural
    // figure is recorded inline from the payload already in hand.
    const body = (await app.inject({ url: "/ollama/models" })).json();

    expect(body.available).toBe(true);
    expect(body.models).toEqual([
      {
        id: "ollama/all-minilm:latest",
        label: "all-minilm:latest",
        provider: "Ollama",
        tier: "budget",
        context_length: 512,
        pricing: { prompt: 0, completion: 0 },
        modality: "text->text",
        description: "Local Ollama model: all-minilm:latest",
      },
      {
        id: "ollama/qwen3:8b",
        label: "qwen3:8b",
        provider: "Ollama",
        tier: "budget",
        context_length: 40960,
        pricing: { prompt: 0, completion: 0 },
        modality: "text->text",
        description: "Local Ollama model: qwen3:8b",
      },
    ]);
    // The list fetch leads; the probe follows unawaited on its own path.
    expect(requestedPaths[0]).toEqual("/api/tags");
    await app.close();
  });

  it("prefers the loaded figure once the /api/ps probe lands", async () => {
    respondTags = (res) =>
      okJson(res, {
        models: [{ name: "all-minilm:latest", details: { context_length: 512 } }],
      });
    respondPs = (res) =>
      okJson(res, { models: [{ name: "all-minilm:latest", context_length: 256 }] });
    const app = await buildRoutes(baseUrl);

    const first = (await app.inject({ url: "/ollama/models" })).json();
    expect(first.models[0].context_length).toBe(512);

    const second = await waitForModels(
      app,
      (models) => models[0].context_length === 256,
    );
    expect(second.models[0].context_length).toBe(256);
    expect(requestedPaths).toContain("/api/ps");
    await app.close();
  });

  it("carries 0 with a complete list on a cold cache", async () => {
    respondTags = (res) =>
      okJson(res, {
        models: [{ name: "plain:latest" }, { name: "other:7b" }],
      });
    const app = await buildRoutes(baseUrl);

    const body = (await app.inject({ url: "/ollama/models" })).json();

    expect(body.available).toBe(true);
    expect(body.models.map((m: { id: string }) => m.id)).toEqual([
      "ollama/plain:latest",
      "ollama/other:7b",
    ]);
    expect(
      body.models.every((m: { context_length: number }) => m.context_length === 0),
    ).toBe(true);
    await app.close();
  });

  // A missing or malformed details value records nothing (absent, not zero);
  // the row still renders 0, and the list stays complete.
  it("treats malformed details as absent rather than zeroing the list", async () => {
    respondTags = (res) =>
      okJson(res, {
        models: [
          { name: "a:latest", details: { context_length: "512" } },
          { name: "b:latest", details: { context_length: 0 } },
          { name: "c:latest", details: {} },
          { name: "d:latest" },
        ],
      });
    const app = await buildRoutes(baseUrl);

    const body = (await app.inject({ url: "/ollama/models" })).json();

    expect(body.available).toBe(true);
    expect(body.models).toHaveLength(4);
    expect(
      body.models.every((m: { context_length: number }) => m.context_length === 0),
    ).toBe(true);
    await app.close();
  });

  // The wire that matters: the route writes a cache entry and the *builder*
  // reads it back. Both sides construct the key from their own constants, so
  // a base-URL or id-form mismatch between them would leave every builder on
  // the fallback while every route test still passed. Exercised through one
  // module graph so the route and the builder share a local-context instance.
  it("hands the route's cached figure to the model builder", async () => {
    respondTags = (res) =>
      okJson(res, { models: [{ name: "wire-test:latest", details: { context_length: 40_960 } }] });
    vi.resetModules();
    vi.stubEnv("OLLAMA_BASE_URL", baseUrl);
    const { registerSystemRoutes } = await import("../src/api/system.ts");
    const { resolveModel } = await import("../src/agent/models.ts");
    const registry = { find: () => undefined } as never;
    const app = Fastify();
    await registerSystemRoutes(app);

    // Cold: nothing probed yet, so the builder declares the fallback.
    expect(resolveModel("ollama/wire-test:latest", registry).contextWindow).toBe(128_000);

    await app.inject({ url: "/ollama/models" });

    // Warm: the figure the route parsed inline reaches the builder, and an
    // untagged ref finds the same entry.
    expect(resolveModel("ollama/wire-test:latest", registry).contextWindow).toBe(40_960);
    expect(resolveModel("ollama/wire-test", registry).contextWindow).toBe(40_960);
    await app.close();
  });

  it("keeps the list when a row has no name at all", async () => {
    // cacheKey normalises by slicing the id, so an unguarded nameless row
    // throws into the route's catch and costs the entire local section.
    // Losing context metadata is acceptable; losing the models is not.
    respondTags = (res) =>
      okJson(res, {
        models: [{ model: "no-name-field" }, { name: "ok:latest", details: { context_length: 4096 } }],
      });
    const app = await buildRoutes(baseUrl);

    const body = (await app.inject({ url: "/ollama/models" })).json();

    expect(body.available).toBe(true);
    expect(body.models).toHaveLength(2);
    expect(body.models[1].context_length).toBe(4096);
    await app.close();
  });

  // A failing /api/ps must never change the response: the rows keep their
  // architectural figures and nothing goes missing.
  it("still returns every row with architectural figures when /api/ps fails", async () => {
    respondTags = (res) =>
      okJson(res, {
        models: [
          { name: "all-minilm:latest", details: { context_length: 512 } },
          { name: "qwen3:8b", details: { context_length: 40960 } },
        ],
      });
    respondPs = (res) => {
      res.writeHead(500);
      res.end("nope");
    };
    const app = await buildRoutes(baseUrl);

    const body = (await app.inject({ url: "/ollama/models" })).json();

    expect(body.available).toBe(true);
    expect(
      body.models.map((m: { context_length: number }) => m.context_length),
    ).toEqual([512, 40960]);
    await app.close();
  });

  it("reports unavailable when the daemon is not running", async () => {
    // Nothing listens on port 1 — a connection refusal, not a timeout.
    const app = await buildRoutes("http://127.0.0.1:1");

    const body = (await app.inject({ url: "/ollama/models" })).json();

    expect(body).toEqual({ available: false, models: [] });
    await app.close();
  });

  // The picker budget is two calls per open: the route's /api/tags plus one
  // /api/ps. A second /api/tags would mean the architectural write went
  // through a re-fetch instead of the payload already in hand.
  it("stays within two calls per open", async () => {
    respondTags = (res) =>
      okJson(res, {
        models: [{ name: "all-minilm:latest", details: { context_length: 512 } }],
      });
    respondPs = (res) => okJson(res, { models: [] });
    const app = await buildRoutes(baseUrl);

    await app.inject({ url: "/ollama/models" });
    const deadline = Date.now() + 5000;
    while (!requestedPaths.includes("/api/ps") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(requestedPaths.filter((p) => p === "/api/tags")).toHaveLength(1);
    expect(requestedPaths.filter((p) => p === "/api/ps").length).toBeGreaterThanOrEqual(1);
    await app.close();
  });
});
