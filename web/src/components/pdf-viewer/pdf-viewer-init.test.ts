import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  installMapUpsertPolyfill,
  buildWorkerUrl,
  MAP_UPSERT_POLYFILL_SRC,
} from "./pdf-viewer";

type UpsertMapProto = typeof Map.prototype & {
  getOrInsertComputed?: (k: unknown, fn: (k: unknown) => unknown) => unknown;
  getOrInsert?: (k: unknown, v: unknown) => unknown;
};

describe("pdf-viewer initialization", () => {
  const proto = Map.prototype as UpsertMapProto;
  let originalGetOrInsertComputed: typeof proto.getOrInsertComputed;
  let originalGetOrInsert: typeof proto.getOrInsert;

  beforeEach(() => {
    originalGetOrInsertComputed = proto.getOrInsertComputed;
    originalGetOrInsert = proto.getOrInsert;
  });

  afterEach(() => {
    if (originalGetOrInsertComputed === undefined) {
      delete proto.getOrInsertComputed;
    } else {
      proto.getOrInsertComputed = originalGetOrInsertComputed;
    }

    if (originalGetOrInsert === undefined) {
      delete proto.getOrInsert;
    } else {
      proto.getOrInsert = originalGetOrInsert;
    }

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("installs Map.prototype.getOrInsertComputed correctly when absent and avoids recomputation", () => {
    delete proto.getOrInsertComputed;
    delete proto.getOrInsert;

    installMapUpsertPolyfill();

    const map = new Map<string, number>() as unknown as {
      getOrInsertComputed: (k: string, fn: (k: string) => number) => number;
      getOrInsert: (k: string, v: number) => number;
      get: (k: string) => number | undefined;
    };

    expect(typeof map.getOrInsertComputed).toBe("function");
    expect(typeof map.getOrInsert).toBe("function");

    const computeFn = vi.fn(() => 100);
    const val1 = map.getOrInsertComputed("k1", computeFn);
    expect(val1).toBe(100);
    expect(map.get("k1")).toBe(100);
    expect(computeFn).toHaveBeenCalledTimes(1);

    // Subsequent calls return existing cached value without calling computeFn
    const secondComputeFn = vi.fn(() => 200);
    const val2 = map.getOrInsertComputed("k1", secondComputeFn);
    expect(val2).toBe(100);
    expect(secondComputeFn).not.toHaveBeenCalled();

    const val3 = map.getOrInsert("k2", 300);
    expect(val3).toBe(300);
    expect(map.get("k2")).toBe(300);
  });

  it("builds a patched blob worker URL with prepended polyfill on successful fetch", async () => {
    const mockWorkerSrc = "console.log('worker code');";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        text: () => Promise.resolve(mockWorkerSrc),
      }),
    );

    if (typeof URL.createObjectURL === "undefined") {
      URL.createObjectURL = () => "";
    }
    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:http://localhost/mock-worker-blob");

    const url = await buildWorkerUrl();
    expect(url).toBe("blob:http://localhost/mock-worker-blob");
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);

    const passedBlob = createObjectURLSpy.mock.calls[0][0] as Blob;
    expect(passedBlob).toBeInstanceOf(Blob);
    expect(passedBlob.type).toBe("text/javascript");

    // Verify blob content contains prepended MAP_UPSERT_POLYFILL_SRC before worker source
    const textContent = await passedBlob.text();
    const polyfillIdx = textContent.indexOf(MAP_UPSERT_POLYFILL_SRC);
    const workerIdx = textContent.indexOf(mockWorkerSrc);
    expect(polyfillIdx).toBeGreaterThanOrEqual(0);
    expect(workerIdx).toBeGreaterThan(polyfillIdx);
  });

  it("falls back to real asset URL if fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network / CORS error")),
    );

    const url = await buildWorkerUrl();
    expect(url).toContain("pdfjs-dist");
    expect(url).toContain("pdf.worker.min.mjs");
  });
});
