/**
 * Unit tests for PDF Viewer initialization, Map upsert polyfill safety,
 * worker URL construction with prepended polyfills, and fallback error handling.
 *
 * Lifecycle Isolation:
 * - beforeEach captures native Map.prototype and URL.createObjectURL states.
 * - afterEach restores all modified prototypes, globals, and mocks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import {
  installMapUpsertPolyfill,
  buildWorkerUrl,
  MAP_UPSERT_POLYFILL_SRC,
  PdfViewer,
} from "./pdf-viewer";

type UpsertMapProto = typeof Map.prototype & {
  getOrInsertComputed?: (k: unknown, fn: (k: unknown) => unknown) => unknown;
  getOrInsert?: (k: unknown, v: unknown) => unknown;
};

describe("pdf-viewer initialization and helpers", () => {
  const proto = Map.prototype as UpsertMapProto;
  let originalGetOrInsertComputed: typeof proto.getOrInsertComputed;
  let originalGetOrInsert: typeof proto.getOrInsert;
  let originalCreateObjectURL: typeof URL.createObjectURL | undefined;

  beforeEach(() => {
    originalGetOrInsertComputed = proto.getOrInsertComputed;
    originalGetOrInsert = proto.getOrInsert;
    originalCreateObjectURL = URL.createObjectURL;
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

    if (originalCreateObjectURL !== undefined) {
      URL.createObjectURL = originalCreateObjectURL;
    } else {
      delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    }

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("installs Map.prototype.getOrInsertComputed correctly when absent and avoids recomputation", () => {
    delete proto.getOrInsertComputed;
    delete proto.getOrInsert;

    installMapUpsertPolyfill();

    const map = new Map<string, string>() as unknown as {
      getOrInsertComputed: (k: string, fn: (k: string) => string) => string;
      getOrInsert: (k: string, v: string) => string;
      get: (k: string) => string | undefined;
    };

    expect(typeof map.getOrInsertComputed).toBe("function");
    expect(typeof map.getOrInsert).toBe("function");

    // Verify compute function receives key argument
    const computeFn = vi.fn((key: string) => `computed-${key}`);
    const val1 = map.getOrInsertComputed("itemA", computeFn);
    expect(val1).toBe("computed-itemA");
    expect(map.get("itemA")).toBe("computed-itemA");
    expect(computeFn).toHaveBeenCalledWith("itemA");
    expect(computeFn).toHaveBeenCalledTimes(1);

    // Subsequent call returns existing cached value without calling computeFn
    const secondComputeFn = vi.fn(() => "new-val");
    const val2 = map.getOrInsertComputed("itemA", secondComputeFn);
    expect(val2).toBe("computed-itemA");
    expect(secondComputeFn).not.toHaveBeenCalled();

    // getOrInsert behavior
    const val3 = map.getOrInsert("itemB", "valB");
    expect(val3).toBe("valB");
    expect(map.get("itemB")).toBe("valB");

    const val4 = map.getOrInsert("itemB", "ignored");
    expect(val4).toBe("valB");
  });

  it("preserves existing native implementations without overwriting", () => {
    const existingComputed = vi.fn(() => "native");
    const existingGetOrInsert = vi.fn(() => "native-insert");

    proto.getOrInsertComputed = existingComputed as unknown as typeof proto.getOrInsertComputed;
    proto.getOrInsert = existingGetOrInsert as unknown as typeof proto.getOrInsert;

    installMapUpsertPolyfill();

    expect(proto.getOrInsertComputed).toBe(existingComputed);
    expect(proto.getOrInsert).toBe(existingGetOrInsert);
  });

  it("builds a patched blob worker URL with prepended polyfill on successful fetch", async () => {
    const mockWorkerSrc = "console.log('worker code');";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(mockWorkerSrc),
    });
    vi.stubGlobal("fetch", fetchMock);

    if (typeof URL.createObjectURL === "undefined") {
      URL.createObjectURL = () => "";
    }
    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:http://localhost/mock-worker-blob");

    const url = await buildWorkerUrl();
    expect(url).toBe("blob:http://localhost/mock-worker-blob");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("pdf.worker.min.mjs");
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

  it("falls back to real asset URL if fetch fails with network error without creating blob", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network / CORS error"));
    vi.stubGlobal("fetch", fetchMock);

    if (typeof URL.createObjectURL === "undefined") {
      URL.createObjectURL = () => "";
    }
    const createObjectURLSpy = vi.spyOn(URL, "createObjectURL");

    const url = await buildWorkerUrl();
    expect(url).toContain("pdfjs-dist");
    expect(url).toContain("pdf.worker.min.mjs");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createObjectURLSpy).not.toHaveBeenCalled();
  });

  it("falls back to real asset URL if fetch returns non-OK HTTP status without creating blob", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("<!DOCTYPE html>404 Not Found"),
    });
    vi.stubGlobal("fetch", fetchMock);

    if (typeof URL.createObjectURL === "undefined") {
      URL.createObjectURL = () => "";
    }
    const createObjectURLSpy = vi.spyOn(URL, "createObjectURL");

    const url = await buildWorkerUrl();
    expect(url).toContain("pdfjs-dist");
    expect(url).toContain("pdf.worker.min.mjs");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createObjectURLSpy).not.toHaveBeenCalled();
  });

  it("mounts PdfViewer without throwing thanks to IntersectionObserver stub", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("/* worker source */"),
    }));

    render(<PdfViewer path="test-document.pdf" projectId="default" hideAnnotationUi={true} />);
    expect(screen.getByText(/loading pdf/i)).toBeInTheDocument();
  });
});
