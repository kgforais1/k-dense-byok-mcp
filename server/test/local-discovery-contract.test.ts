import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

// The two local discovery routes must answer a malformed server the same way.
// They did not, for a while, and the cost was three separate bugs: each was
// found on one provider, fixed there, and left standing on the other until a
// later reviewer noticed the asymmetry. `ollama.test.ts` and
// `openai-compatible.test.ts` cover each route's own behaviour; this file
// covers only what the two owe *each other*, so a fix applied to one and not
// the other fails here rather than shipping.
//
// The shared rules, all of them learned from a real defect:
//
//   - A top-level payload that is not an object is a malformed answer, not an
//     empty one. Reporting `available: true` with no rows makes the picker say
//     the server is up and holds nothing, which is the wrong thing to tell
//     someone whose server is full and whose proxy answered with nonsense.
//   - A list field that is present but not an array is malformed the same way.
//   - A list field that is *absent* is an honest empty: a server saying it has
//     none. This is the one shape that must stay `available: true`.
//   - An unusable row is dropped on its own; the rest of the list survives.
//     Losing context metadata is acceptable, losing the model list is not.
//   - Identifiers are rejected on the same predicate, including whitespace.

/** What one provider needs for the shared cases to be expressible. */
type Provider = {
  name: string;
  /** Env var the route reads its base URL from. */
  envVar: string;
  /** Route under test. */
  url: string;
  /** Path prefix of the list endpoint on the fake upstream. */
  listPath: string;
  /** Path prefix of the background context probe, which 404s throughout. */
  probePath: string;
  /** The key holding the array of models in the upstream's payload. */
  listField: string;
  /** Builds the row shape this provider's upstream would send. */
  row: (id: unknown) => unknown;
  /** The picker id the route should emit for `id`. */
  expectedId: (id: string) => string;
};

const PROVIDERS: Provider[] = [
  {
    name: "ollama",
    envVar: "OLLAMA_BASE_URL",
    url: "/ollama/models",
    listPath: "/api/tags",
    probePath: "/api/ps",
    listField: "models",
    row: (id) => ({ name: id, details: { context_length: 4096 } }),
    expectedId: (id) => `ollama/${id}`,
  },
  {
    name: "openai-compatible",
    envVar: "OPENAI_COMPATIBLE_BASE_URL",
    url: "/openai-compatible/models",
    listPath: "/v1/models",
    probePath: "/api/v0/models",
    listField: "data",
    row: (id) => ({ id }),
    expectedId: (id) => `openai-compatible/${id}`,
  },
];

describe.each(PROVIDERS)("local discovery contract: $name", (provider) => {
  let server: http.Server;
  let baseUrl: string;
  /** Serves the list endpoint; set by each test. */
  let respondList: (res: http.ServerResponse) => void;

  function okJson(res: http.ServerResponse, payload: unknown) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  }

  beforeEach(async () => {
    respondList = (res) => okJson(res, { [provider.listField]: [] });
    server = http.createServer((req, res) => {
      const url = req.url ?? "";
      // The probe 404s throughout: this file is about the list, and a probe
      // that fails must never change the list's shape anyway.
      if (url.startsWith(provider.probePath)) {
        res.writeHead(404);
        res.end("nope");
      } else if (url.startsWith(provider.listPath)) {
        respondList(res);
      } else {
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

  /** config.ts reads the environment once at import, so the route is loaded
   * fresh per test with the base URL already pointing at the fake server. */
  async function ask() {
    vi.resetModules();
    vi.stubEnv(provider.envVar, baseUrl);
    const { registerSystemRoutes } = await import("../src/api/system.ts");
    const app = Fastify();
    await registerSystemRoutes(app);
    const body = (await app.inject({ url: provider.url })).json();
    await app.close();
    return body as {
      available: boolean;
      models: { id: string; context_length: number }[];
    };
  }

  // A payload with no list field at all is deliberately excluded here — that
  // is the honest-empty case, and it has its own test below.
  it.each([
    ["a string", "nope"],
    ["a number", 7],
    ["a boolean", true],
    ["a top-level array", [] as unknown],
    ["a top-level array of rows", [{ id: "a", name: "a" }] as unknown],
  ])("reports %s payload as unavailable", async (_label, payload) => {
    respondList = (res) => okJson(res, payload);

    const body = await ask();

    expect(body.available).toBe(false);
    expect(body.models).toEqual([]);
  });

  it.each([
    ["a string", "not-an-array"],
    ["an object", { nested: true }],
    ["a number", 0],
  ])(
    `reports %s as the ${provider.listField} field as unavailable`,
    async (_label, listValue) => {
      respondList = (res) => okJson(res, { [provider.listField]: listValue });

      const body = await ask();

      expect(body.available).toBe(false);
      expect(body.models).toEqual([]);
    },
  );

  it("treats an absent list field as an honest empty server", async () => {
    // The one benign shape, and the reason the cases above cannot simply
    // check for "no rows": this must stay available, because it is what a
    // server with nothing loaded actually says.
    respondList = (res) => okJson(res, { object: "list" });

    const body = await ask();

    expect(body.available).toBe(true);
    expect(body.models).toEqual([]);
  });

  it("serves an empty list as an empty list", async () => {
    respondList = (res) => okJson(res, { [provider.listField]: [] });

    const body = await ask();

    expect(body.available).toBe(true);
    expect(body.models).toEqual([]);
  });

  it("drops unusable rows and keeps the usable ones", async () => {
    // Every shape here would once have thrown into the route's catch and
    // blanked the whole section, or been rendered as a selectable row that
    // resolves to nothing.
    respondList = (res) =>
      okJson(res, {
        [provider.listField]: [
          null,
          "a string row",
          7,
          {},
          provider.row(undefined),
          provider.row(""),
          provider.row("   "),
          provider.row(7),
          provider.row("usable"),
        ],
      });

    const body = await ask();

    expect(body.available).toBe(true);
    expect(body.models.map((m) => m.id)).toEqual([
      provider.expectedId("usable"),
    ]);
  });

  it("reports an unreachable server as unavailable", async () => {
    // Nothing listens on port 1 — the baseline both routes already shared,
    // pinned here so the malformed cases above are read against it.
    vi.resetModules();
    vi.stubEnv(provider.envVar, "http://127.0.0.1:1");
    const { registerSystemRoutes } = await import("../src/api/system.ts");
    const app = Fastify();
    await registerSystemRoutes(app);

    const body = (await app.inject({ url: provider.url })).json();

    expect(body.available).toBe(false);
    expect(body.models).toEqual([]);
    await app.close();
  });
});
