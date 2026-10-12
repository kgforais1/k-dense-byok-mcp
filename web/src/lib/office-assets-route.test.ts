// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bytes = Buffer.from("tested runtime");
const sha256 = createHash("sha256").update(bytes).digest("hex");
let root: string;
let get: typeof import("../app/office-assets/[build]/[file]/route").GET;
const fetcher = vi.fn();
const response = (data = bytes) => new Response(new Uint8Array(data));
const request = (file = "soffice.js", build = "tested") =>
  get(new Request("http://localhost/office-assets"), { params: Promise.resolve({ file, build }) });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "office-assets-test-"));
  vi.stubEnv("KADY_OFFICE_ASSETS_DIR", root);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset().mockImplementation(() => Promise.resolve(response()));
  vi.resetModules();
  vi.doMock("@/lib/office-assets", () => ({
    OFFICE_BUILD: "tested", OFFICE_ASSET_BASE: "https://mirror.test/tested-",
    OFFICE_ASSETS: { "soffice.js": { sha256, size: bytes.length, type: "text/javascript" } },
  }));
  get = (await import("../app/office-assets/[build]/[file]/route")).GET;
});
afterEach(async () => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.doUnmock("@/lib/office-assets");
  await rm(root, { recursive: true, force: true });
});

describe("retained Office runtime route", () => {
  it("finishes a valid slow body transfer beyond the former three-minute deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("Download timed out")), ms);
      return controller.signal;
    });
    let started!: () => void;
    const downloading = new Promise<void>(resolve => { started = resolve; });
    fetcher.mockImplementationOnce((_url, { signal }: { signal: AbortSignal }) =>
      new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new Uint8Array(bytes.subarray(0, 4)));
        const delivery = setTimeout(() => {
          controller.enqueue(new Uint8Array(bytes.subarray(4))); controller.close();
        }, 181_000);
        signal.addEventListener("abort", () => {
          clearTimeout(delivery); controller.error(signal.reason);
        }, { once: true });
        started();
      } })),
    );
    const job = request();
    await downloading;
    await vi.advanceTimersByTimeAsync(181_000);
    const result = await job;
    expect(result.status).toBe(200);
    expect(Buffer.from(await result.arrayBuffer())).toEqual(bytes);
    expect(await readFile(join(root, "soffice.js"))).toEqual(bytes);
  });
  it("fills a cold cache from the retained build and then serves it offline", async () => {
    const first = await request();
    expect(first.status).toBe(200);
    expect(Buffer.from(await first.arrayBuffer())).toEqual(bytes);
    expect(first.headers.get("Cache-Control")).toContain("immutable");
    expect(fetcher).toHaveBeenCalledWith("https://mirror.test/tested-soffice.js", expect.any(Object));
    fetcher.mockRejectedValue(new Error("offline"));
    expect(Buffer.from(await (await request()).arrayBuffer())).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, "soffice.js"))).toEqual(bytes);
  });
  it("rejects changed download bytes without caching them and permits retry", async () => {
    fetcher.mockResolvedValueOnce(response(Buffer.from("changed runtime")));
    expect((await request()).status).toBe(503);
    expect(await readdir(root)).toEqual([]);
    const retry = await request();
    expect(retry.status).toBe(200); await retry.arrayBuffer();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("replaces corrupt cached bytes only with a verified download", async () => {
    await writeFile(join(root, "soffice.js"), "corrupt cache");
    expect(Buffer.from(await (await request()).arrayBuffer())).toEqual(bytes);
    expect(await readFile(join(root, "soffice.js"))).toEqual(bytes);
  });
  it("rejects oversized downloads and unavailable mirrors without installing files", async () => {
    fetcher.mockResolvedValueOnce(response(Buffer.alloc(2048)));
    expect((await request()).status).toBe(503);
    fetcher.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    expect((await request()).status).toBe(503);
    expect(await readdir(root)).toEqual([]);
  });
  it("rejects unknown builds and paths before fetching", async () => {
    expect((await request("soffice.js", "unknown")).status).toBe(404);
    expect((await request("../soffice.js")).status).toBe(404);
    expect((await request("__proto__")).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
