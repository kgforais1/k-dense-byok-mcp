import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as undici from "undici";

// Node's built-in fetch ignores HTTP_PROXY/HTTPS_PROXY (NODE_USE_ENV_PROXY is
// Node >= 24 only), so before src/http-proxy.ts the backend dialled providers
// directly while the child `pi` processes running subagents went through the
// proxy — the split behind issue #26. These tests pin the actual mechanism:
// a real local proxy must see the request that global fetch makes.

// undici.install() swaps ~10 globals; test files share a worker process
// (fileParallelism: false), so everything is snapshotted and put back.
const INSTALLED_GLOBALS = [
  "fetch",
  "Headers",
  "Response",
  "Request",
  "FormData",
  "WebSocket",
  "CloseEvent",
  "ErrorEvent",
  "MessageEvent",
  "EventSource",
] as const;

type MutableGlobal = Record<string, unknown>;

let savedGlobals: MutableGlobal = {};
let savedDispatcher: undici.Dispatcher;
let origin: http.Server;
let proxy: http.Server;
let proxyUrl: string;
/** Hosts the proxy was asked to tunnel to, e.g. "example.invalid:80". */
let tunneled: string[];

/** Payload for the compressed-streaming regression below (kept small). */
const COMPRESSED_BODY = `kady-compressed-stream:${"0123456789abcdef".repeat(2048)}`;
const COMPRESSED_GZIP = zlib.gzipSync(COMPRESSED_BODY);

/** Load a fresh copy so the module-level memo doesn't leak between tests. */
async function loadModule() {
  vi.resetModules();
  return await import("../src/http-proxy.ts");
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

beforeEach(async () => {
  savedDispatcher = undici.getGlobalDispatcher();
  savedGlobals = {};
  for (const name of INSTALLED_GLOBALS) {
    savedGlobals[name] = (globalThis as MutableGlobal)[name];
  }

  tunneled = [];
  origin = http.createServer((req, res) => {
    if (req.url === "/compressed") {
      // Staggered gzip chunks over a CONNECT tunnel: exercises streamed
      // decompression rather than a single buffered body.
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      const chunks = 7;
      const size = Math.ceil(COMPRESSED_GZIP.length / chunks);
      let i = 0;
      const timer = setInterval(() => {
        if (i < chunks) {
          res.write(COMPRESSED_GZIP.subarray(i * size, (i + 1) * size));
          i += 1;
        } else {
          clearInterval(timer);
          res.end();
        }
      }, 15);
      res.on("close", () => clearInterval(timer));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ via: "proxy" }));
  });
  const originPort = await listen(origin);

  // undici tunnels through a proxy with CONNECT (proxyTunnel defaults to true)
  // even for http:// targets, so a request handler alone is not enough. Like a
  // real middlebox, this one ignores the requested host and splices the tunnel
  // to the local origin server — which is what proves the traffic went via the
  // proxy rather than resolving the (unresolvable) target host directly.
  proxy = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  proxy.on("connect", (req, clientSocket, head) => {
    tunneled.push(req.url ?? "");
    const upstream = net.connect(originPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
});

afterEach(async () => {
  for (const name of INSTALLED_GLOBALS) {
    (globalThis as MutableGlobal)[name] = savedGlobals[name];
  }
  // Hand the process back its original dispatcher and tear down whatever this
  // test installed — otherwise its keep-alive tunnel holds the servers open.
  const installed = undici.getGlobalDispatcher();
  undici.setGlobalDispatcher(savedDispatcher);
  if (installed !== savedDispatcher) await installed.destroy().catch(() => {});
  proxy.closeAllConnections();
  origin.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await new Promise<void>((resolve) => origin.close(() => resolve()));
});

describe("configureHttpProxy", () => {
  it("is a no-op when no proxy variable is set", async () => {
    const { configureHttpProxy } = await loadModule();
    const before = undici.getGlobalDispatcher();

    expect(configureHttpProxy({})).toEqual({ enabled: false });
    expect(undici.getGlobalDispatcher()).toBe(before);
  });

  it("reports NO_PROXY even when it installs nothing", async () => {
    const { configureHttpProxy } = await loadModule();

    expect(configureHttpProxy({ NO_PROXY: "localhost,127.0.0.1" })).toEqual({
      enabled: false,
      noProxy: "localhost,127.0.0.1",
    });
  });

  it("routes global fetch through the proxy named by http_proxy", async () => {
    const { configureHttpProxy } = await loadModule();
    const status = configureHttpProxy({ http_proxy: proxyUrl });
    expect(status.enabled).toBe(true);

    // `.invalid` never resolves, so a direct connection could not succeed:
    // reaching a 200 proves the request went through the proxy.
    const resp = await fetch("http://kady-proxy-test.invalid/v1/models");

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ via: "proxy" });
    expect(tunneled).toEqual(["kady-proxy-test.invalid:80"]);
  });

  it("honours NO_PROXY for hosts that should bypass the proxy", async () => {
    const { configureHttpProxy } = await loadModule();
    configureHttpProxy({ http_proxy: proxyUrl, no_proxy: "kady-proxy-test.invalid" });

    // Excluded from the proxy, so this falls back to a direct connection and
    // fails DNS on the unresolvable host rather than being served a 200.
    await expect(fetch("http://kady-proxy-test.invalid/v1/models")).rejects.toThrow();
    expect(tunneled).toEqual([]);
  });

  it("streams a gzip response through the proxy with the body decompressed", async () => {
    const { configureHttpProxy } = await loadModule();
    configureHttpProxy({ http_proxy: proxyUrl });

    // `.invalid` never resolves, so reaching the origin proves proxy routing.
    // Reading via a stream reader (not a single buffered read) proves the
    // staggered gzip chunks are decompressed on the way through — guarding
    // the npm-dispatcher/Node-fetch handler mismatch noted in src/http-proxy.ts,
    // where a foreign dispatcher once yielded compressed bytes as-is.
    const resp = await fetch("http://kady-proxy-test.invalid/compressed");
    expect(resp.status).toBe(200);
    const body = resp.body;
    expect(body).not.toBeNull();
    const reader = (body as NonNullable<typeof body>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    expect(text).toBe(COMPRESSED_BODY);
    expect(tunneled).toEqual(["kady-proxy-test.invalid:80"]);
  });

  it("memoizes, so a second call cannot re-install the dispatcher", async () => {
    const { configureHttpProxy } = await loadModule();

    const first = configureHttpProxy({ http_proxy: proxyUrl });
    const installed = undici.getGlobalDispatcher();
    const second = configureHttpProxy({ http_proxy: "http://127.0.0.1:9/" });

    expect(second).toBe(first);
    expect(undici.getGlobalDispatcher()).toBe(installed);
  });

  it("redacts proxy credentials in the reported status", async () => {
    const { configureHttpProxy } = await loadModule();

    const status = configureHttpProxy({
      https_proxy: "http://alice:hunter2@proxy.internal:3128",
      NO_PROXY: "localhost",
    });

    expect(status.httpsProxy).toBe("http://***@proxy.internal:3128/");
    expect(status.httpsProxy).not.toContain("hunter2");
    expect(status.noProxy).toBe("localhost");
  });

  it("prefers the lowercase variable, matching undici's precedence", async () => {
    const { configureHttpProxy } = await loadModule();

    const status = configureHttpProxy({
      http_proxy: "http://lower.internal:3128",
      HTTP_PROXY: "http://upper.internal:3128",
    });

    expect(status.httpProxy).toBe("http://lower.internal:3128/");
  });
});

describe("redactProxyUrl", () => {
  it("leaves a credential-free URL alone", async () => {
    const { redactProxyUrl } = await loadModule();
    expect(redactProxyUrl("http://proxy.internal:3128")).toBe("http://proxy.internal:3128/");
  });

  it("does not throw on a malformed value", async () => {
    const { redactProxyUrl } = await loadModule();
    expect(redactProxyUrl("not a url")).toBe("(unparseable proxy URL)");
  });
});

describe("loopback bypass", () => {
  it("always exempts loopback from the proxy, keeping the user's entries", async () => {
    const { withLoopbackNoProxy } = await import("../src/http-proxy.ts");
    expect(withLoopbackNoProxy(undefined)).toBe("localhost,127.0.0.1,::1");
    expect(withLoopbackNoProxy("corp.example, localhost")).toBe("corp.example,localhost,127.0.0.1,::1");
    expect(withLoopbackNoProxy("*")).toBe("*");
  });
});
