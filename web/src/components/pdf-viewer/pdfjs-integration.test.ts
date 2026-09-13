// @vitest-environment node
/**
 * Integration test against the *real* pdfjs-dist module.
 *
 * Every other test around the PDF viewer mocks pdfjs, which is what let the
 * pdfjs 5 -> 6 upgrade remove `PDFDocumentProxy.destroy()` without a single
 * test failing. A mock has whatever shape the test gives it, so it can only
 * confirm our own assumptions back to us.
 *
 * This file loads the library for real, opens a real PDF, and asserts the
 * handful of API facts `pdf-viewer.tsx` depends on. A future pdfjs that moved
 * any of them would otherwise reach a user before it reached CI.
 *
 * Scope: Node can exercise module loading, document parsing, the API surface,
 * text extraction and teardown. It cannot exercise canvas rasterisation or the
 * DOM text layer, which need a browser; those were checked by hand for the 6.x
 * upgrade and are noted in `dev-docs/todo.md` as the remaining coverage gap.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(
  new URL("./__fixtures__/one-line.pdf", import.meta.url),
);
// pdfjs joins `standardFontDataUrl` with a filename and fetches the result, so
// the separators have to be forward slashes. `fileURLToPath` hands back native
// ones, which on Windows — where CI also runs the frontend suite — would produce
// a path pdfjs cannot load. Keep the filesystem path, swap the separators.
const STANDARD_FONTS = fileURLToPath(
  new URL("../../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url),
).replaceAll("\\", "/");

async function loadPdfjs() {
  // The legacy build is the one that runs outside a browser.
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

/**
 * The entry point the app itself imports. Only its exported surface is touched
 * here — the modern build is not meant to *run* under Node.
 */
async function loadAppEntry() {
  return import("pdfjs-dist");
}

async function openFixture(pdfjs: Awaited<ReturnType<typeof loadPdfjs>>) {
  return pdfjs.getDocument({
    data: new Uint8Array(readFileSync(FIXTURE)),
    standardFontDataUrl: STANDARD_FONTS,
  }).promise;
}

/**
 * The pdfjs major last checked by hand in a browser: a real PDF opened, page 1
 * rasterised to a canvas, the DOM text layer built, and the blob-patched worker
 * exercised. Node cannot do any of that, so this constant is what turns the
 * manual check from a one-off into something with a trigger.
 *
 * When a major bump makes this fail, do the browser pass again before raising
 * the number. `dev-docs/todo.md` §2 records what the pass covers.
 *
 * This alone is not a sufficient trigger: a 6.x minor could change worker
 * loading or the `TextLayer` signature without moving the major. That is why
 * `pdfjs-dist` is pinned exactly in `web/package.json` — every bump arrives as
 * a reviewed PR rather than floating in on a lockfile refresh.
 */
const BROWSER_VERIFIED_MAJOR = 6;

describe("pdfjs-dist integration", () => {
  it("is still on the pdfjs major that was verified in a browser", async () => {
    const pdfjs = await loadPdfjs();

    expect(Number(pdfjs.version.split(".")[0])).toBe(BROWSER_VERIFIED_MAJOR);
  });

  it("opens a real PDF and reports its page count", async () => {
    const pdfjs = await loadPdfjs();
    const doc = await openFixture(pdfjs);

    expect(doc.numPages).toBe(1);

    await doc.loadingTask.destroy();
  });

  it("exposes teardown on the loading task, not the document", async () => {
    const pdfjs = await loadPdfjs();
    const doc = await openFixture(pdfjs);

    // This pair is the pdfjs 6 breaking change that `destroyDoc` exists for.
    // If a future release restores or re-removes either one, fail here rather
    // than at runtime in a user's viewer.
    expect(
      (doc as unknown as { destroy?: unknown }).destroy,
    ).toBeUndefined();
    expect(typeof doc.loadingTask.destroy).toBe("function");

    await expect(doc.loadingTask.destroy()).resolves.toBeUndefined();
  });

  /**
   * Everything else in this file exercises the legacy build, because that is
   * the one that runs under Node. The viewer imports plain `pdfjs-dist`. The
   * two are different bundles, so assert they still agree on the facts the
   * other tests here rely on — otherwise those tests could pass while the app
   * loads something that behaves differently.
   */
  it("agrees with the build the app actually imports", async () => {
    const [legacy, app] = await Promise.all([loadPdfjs(), loadAppEntry()]);

    expect(app.version).toBe(legacy.version);
    expect(Object.keys(app).sort()).toEqual(Object.keys(legacy).sort());
  });

  it("still exports the TextLayer constructor the viewer builds text with", async () => {
    const pdfjs = await loadPdfjs();

    // `pdf-viewer.tsx` reaches for `TextLayer` through an `as unknown as` cast,
    // so its removal would be silent: the viewer would render pages with no
    // selectable text and no error. Assert it directly.
    expect(
      typeof (pdfjs as unknown as { TextLayer?: unknown }).TextLayer,
    ).toBe("function");
  });

  it("extracts the fixture's text", async () => {
    const pdfjs = await loadPdfjs();
    const doc = await openFixture(pdfjs);
    const page = await doc.getPage(1);

    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join("");

    expect(text).toBe("pdfjs fixture page");

    await doc.loadingTask.destroy();
  });

  it("computes a scaled viewport", async () => {
    const pdfjs = await loadPdfjs();
    const doc = await openFixture(pdfjs);
    const page = await doc.getPage(1);

    // The fixture's MediaBox is 200x100, and the viewer renders at BASE_SCALE 1.5.
    const viewport = page.getViewport({ scale: 1.5 });
    expect(Math.round(viewport.width)).toBe(300);
    expect(Math.round(viewport.height)).toBe(150);

    await doc.loadingTask.destroy();
  });
});
