import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  buildOpenAICompatibleModel,
  modelReference,
  resolveModel,
  ModelResolutionError,
  assertModelAuthentication,
} from "../src/agent/models.ts";
import { getModelRegistry } from "../src/agent/session-registry.ts";
import {
  billingCountsTowardBudget,
  billingForModel,
  billingForProvider,
} from "../src/cost/billing.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import { emptySnapshot, recordRun, sessionCostSummary } from "../src/cost/ledger.ts";
import {
  makeSubagentLedgerExtension,
  pinInheritedChildModels,
} from "../src/agent/subagent-bridge.ts";

// A local OpenAI-compatible server (LM Studio, vLLM, …) discovered through the
// standard /v1/models endpoint. Everything here is local-only by design: the $0
// pricing below is only honest because the model runs on the user's hardware.

describe("buildOpenAICompatibleModel", () => {
  it("builds a $0, non-reasoning model against the configured base URL", () => {
    const model = buildOpenAICompatibleModel("qwen3-8b");

    expect(model.provider).toBe("openai-compatible");
    expect(model.id).toBe("qwen3-8b");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toMatch(/\/v1$/);
    expect(model.reasoning).toBe(false);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("round-trips through modelReference", () => {
    const model = buildOpenAICompatibleModel("qwen3-8b");
    expect(modelReference(model)).toBe("openai-compatible/qwen3-8b");
  });
});

describe("resolveModel (openai-compatible refs)", () => {
  it("resolves a bare model id", () => {
    const model = resolveModel("openai-compatible/qwen3-8b", getModelRegistry());
    expect(model.provider).toBe("openai-compatible");
    expect(model.id).toBe("qwen3-8b");
  });

  // LM Studio ids routinely contain a slash ("qwen/qwen3-8b"), so only the
  // provider prefix may be stripped — splitting on every "/" would truncate.
  it("keeps slashes inside the model id", () => {
    const model = resolveModel("openai-compatible/qwen/qwen3-8b", getModelRegistry());
    expect(model.id).toBe("qwen/qwen3-8b");
    expect(modelReference(model)).toBe("openai-compatible/qwen/qwen3-8b");
  });

  it("rejects a ref with no model id", () => {
    expect(() => resolveModel("openai-compatible/", getModelRegistry())).toThrow(
      ModelResolutionError,
    );
  });

  it("needs no provider auth (the credential is a placeholder)", async () => {
    const runtime = { checkAuth: vi.fn() };
    await expect(
      assertModelAuthentication(buildOpenAICompatibleModel("qwen3-8b"), runtime as never),
    ).resolves.toBeUndefined();
    expect(runtime.checkAuth).not.toHaveBeenCalled();
  });
});

describe("billing", () => {
  it("is local, so it never counts against the project spend cap", () => {
    const billing = billingForProvider("openai-compatible");
    expect(billing).toEqual({
      provider: "openai-compatible",
      authType: "local",
      billingMode: "local",
    });
    expect(billingCountsTowardBudget(billing)).toBe(false);
  });

  it("classifies the model without consulting provider auth", async () => {
    const runtime = { checkAuth: vi.fn() };
    const billing = await billingForModel(
      buildOpenAICompatibleModel("qwen3-8b"),
      runtime as never,
    );
    expect(billing.billingMode).toBe("local");
    expect(runtime.checkAuth).not.toHaveBeenCalled();
  });

  // Without the prefix rule in the ledger, an openai-compatible row falls
  // through to the payg default and is counted as billable spend.
  it("ledgers a run as local rather than payg", () => {
    createProject({ name: "OAI compat", projectId: "oai-compat" });
    resolvePaths("oai-compat");
    const entry = recordRun({
      sessionId: "s1",
      projectId: "oai-compat",
      model: "openai-compatible/qwen3-8b",
      before: emptySnapshot(),
      after: { ...emptySnapshot(), input: 10, output: 5, total: 15 },
    });

    expect(entry).not.toBeNull();
    expect(entry!.billingMode).toBe("local");
    expect(entry!.provider).toBe("openai-compatible");
    expect(entry!.costUsd).toBe(0);
  });

  // Subagents resolve their own billing from the child's model ref, on a code
  // path separate from the ledger's — it needs the same prefix rule.
  it("ledgers a subagent run on a local model as local", async () => {
    createProject({ name: "OAI compat sub", projectId: "oai-compat-sub" });
    const handlers = new Map<string, (event: any) => any>();
    const extension = makeSubagentLedgerExtension(
      "oai-compat-sub",
      () => "parent-session",
      () =>
        ({
          provider: "openrouter",
          id: "anthropic/claude-opus-5",
        }) as Parameters<typeof pinInheritedChildModels>[2],
      () => false,
    );
    extension({
      on: (name: string, handler: (event: any) => any) => handlers.set(name, handler),
      events: { on: () => {} },
    } as any);

    await handlers.get("tool_result")!({
      toolName: "subagent",
      details: {
        results: [
          {
            modelAttempts: [
              {
                model: "openai-compatible/qwen3-8b",
                usage: { input: 30, output: 10, cost: 0 },
              },
            ],
          },
        ],
      },
    });

    const summary = sessionCostSummary("parent-session", "oai-compat-sub");
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0].billingMode).toBe("local");
    expect(summary.totalUsd).toBe(0);
  });
});

describe("GET /openai-compatible/models", () => {
  let server: http.Server;
  let baseUrl: string;
  /** Set by each test to control what the fake server returns. */
  let respond: (res: http.ServerResponse) => void;
  /** Serves the native `/api/v0/models` probe; defaults to 404 (vLLM et al.). */
  let respondNative: (res: http.ServerResponse) => void;
  let requestedPaths: string[];

  function notFound(res: http.ServerResponse) {
    res.writeHead(404);
    res.end("nope");
  }

  beforeEach(async () => {
    requestedPaths = [];
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    };
    respondNative = notFound;
    server = http.createServer((req, res) => {
      const url = req.url ?? "";
      requestedPaths.push(url);
      if (url.startsWith("/api/v0/models")) respondNative(res);
      else respond(res);
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
  async function buildRoutes(envBaseUrl: string | undefined) {
    vi.resetModules();
    if (envBaseUrl === undefined) {
      vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "");
    } else {
      vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", envBaseUrl);
    }
    const { registerSystemRoutes } = await import("../src/api/system.ts");
    const app = Fastify();
    await registerSystemRoutes(app);
    return app;
  }

  /**
   * The context probe fires unawaited after the list is served, so a test
   * that wants the post-probe rows re-opens the picker until they appear.
   * Each re-open re-fires (or joins) the probe; the dedup in local-context.ts
   * keeps rival probes from racing.
   */
  async function waitForModels(
    app: Pick<Awaited<ReturnType<typeof buildRoutes>>, "inject">,
    predicate: (models: { context_length: number }[]) => boolean,
  ): Promise<{
    available: boolean;
    configured: boolean;
    models: { context_length: number }[];
  }> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const body = (await app.inject({ url: "/openai-compatible/models" })).json();
      if (predicate(body.models)) return body;
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for the context probe to land");
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it("maps /v1/models into the picker's model shape", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "qwen/qwen3-8b" }, { id: "llama-3.1-8b-instruct" }],
        }),
      );
    };
    respondNative = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            {
              id: "qwen/qwen3-8b",
              max_context_length: 32768,
              loaded_context_length: 16384,
            },
            { id: "llama-3.1-8b-instruct", max_context_length: 131072 },
          ],
        }),
      );
    };
    const app = await buildRoutes(baseUrl);

    // Cold cache: the honest answer is 0, which the picker renders as no
    // badge. The rows are built before the probe fires, so this holds no
    // matter how fast the probe answers.
    const first = (await app.inject({ url: "/openai-compatible/models" })).json();

    expect(first.available).toBe(true);
    expect(first.configured).toBe(true);
    expect(first.models).toEqual([
      {
        id: "openai-compatible/qwen/qwen3-8b",
        label: "qwen/qwen3-8b",
        provider: "OpenAI-Compatible",
        tier: "budget",
        context_length: 0,
        pricing: { prompt: 0, completion: 0 },
        modality: "text->text",
        description: "Local OpenAI-compatible model: qwen/qwen3-8b",
      },
      {
        id: "openai-compatible/llama-3.1-8b-instruct",
        label: "llama-3.1-8b-instruct",
        provider: "OpenAI-Compatible",
        tier: "budget",
        context_length: 0,
        pricing: { prompt: 0, completion: 0 },
        modality: "text->text",
        description: "Local OpenAI-compatible model: llama-3.1-8b-instruct",
      },
    ]);
    // The list fetch leads; the probe follows unawaited on its own path.
    expect(requestedPaths[0]).toEqual("/v1/models");

    // Reopening serves the probed figures — loaded preferred where present.
    const second = await waitForModels(
      app,
      (models) => models.every((m) => m.context_length > 0),
    );
    expect(second.models.map((m: { context_length: number }) => m.context_length)).toEqual(
      [16384, 131072],
    );
    expect(requestedPaths).toContain("/api/v0/models");
    await app.close();
  });

  // `/api/v0/models` is LM Studio's own endpoint: vLLM,
  // text-generation-webui and the rest 404 it. Losing context metadata is
  // acceptable; losing the model list is not — the probe failure must never
  // change the response.
  it("returns the full list with 0s when the native endpoint 404s", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [{ id: "model-a" }, { id: "model-b" }],
        }),
      );
    };
    // respondNative stays the default 404.
    const app = await buildRoutes(baseUrl);

    const body = (await app.inject({ url: "/openai-compatible/models" })).json();

    expect(body.available).toBe(true);
    expect(body.models.map((m: { id: string }) => m.id)).toEqual([
      "openai-compatible/model-a",
      "openai-compatible/model-b",
    ]);
    expect(body.models.every((m: { context_length: number }) => m.context_length === 0)).toBe(
      true,
    );

    // And still after the 404 has landed. The probe learned nothing, so the
    // rows keep their honest 0s and, more importantly, the list is intact.
    const deadline = Date.now() + 5000;
    while (!requestedPaths.includes("/api/v0/models") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(requestedPaths).toContain("/api/v0/models");
    const reopened = (await app.inject({ url: "/openai-compatible/models" })).json();
    expect(reopened.models.map((m: { id: string }) => m.id)).toEqual([
      "openai-compatible/model-a",
      "openai-compatible/model-b",
    ]);
    expect(
      reopened.models.every((m: { context_length: number }) => m.context_length === 0),
    ).toBe(true);
    await app.close();
  });

  // One odd row must not blank out the list: servers disagree on everything
  // except `id`, and some emit padding entries.
  it("skips malformed entries instead of failing discovery", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "good-model" },
            { name: "no-id-field" },
            { id: "" },
            { id: 42 },
            null,
            { id: "good-model" },
            { id: "second-model", owned_by: "someone" },
          ],
        }),
      );
    };
    const app = await buildRoutes(baseUrl);

    const body = (await app.inject({ url: "/openai-compatible/models" })).json();

    expect(body.available).toBe(true);
    expect(body.models.map((m: { id: string }) => m.id)).toEqual([
      "openai-compatible/good-model",
      "openai-compatible/second-model",
    ]);
    await app.close();
  });

  it("reports unavailable when the server is not running", async () => {
    // Nothing listens on port 1 — a connection refusal, not a timeout.
    const app = await buildRoutes("http://127.0.0.1:1");

    const body = (await app.inject({ url: "/openai-compatible/models" })).json();

    expect(body).toEqual({ available: false, configured: true, models: [] });
    await app.close();
  });

  it("reports unavailable when the server answers with an error status", async () => {
    respond = (res) => {
      res.writeHead(500);
      res.end("nope");
    };
    const app = await buildRoutes(baseUrl);

    const body = (await app.inject({ url: "/openai-compatible/models" })).json();

    expect(body).toEqual({ available: false, configured: true, models: [] });
    await app.close();
  });

  // `configured: false` is what keeps the picker section hidden for the many
  // users who have never run one of these servers.
  it("reports configured:false when the base URL was never set", async () => {
    const app = await buildRoutes(undefined);

    const body = (await app.inject({ url: "/openai-compatible/models" })).json();

    expect(body.configured).toBe(false);
    await app.close();
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const app = await buildRoutes(`${baseUrl}/`);

    await app.inject({ url: "/openai-compatible/models" });

    // The unawaited probe follows on its own path; the list fetch leads.
    expect(requestedPaths[0]).toEqual("/v1/models");
    await app.close();
  });
});
