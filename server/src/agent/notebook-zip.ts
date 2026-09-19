/**
 * Bundle a session notebook as a zip: lab-notebook.md (links rewritten to the
 * bundle) + the referenced artifact files under artifacts/<sandbox-relative>.
 * Built in memory (adm-zip toBuffer), consistent with /sandbox/download-all.
 * Artifacts that are missing, escape the sandbox, or aren't regular files are
 * skipped and reported in `missing` (the markdown notes them inline).
 *
 * This is the only adm-zip call site in `src/`, and it only ever writes:
 * `new AdmZip()` empty, `addLocalFile`, `addFile`, `toBuffer`. That is load
 * bearing, and the reason is narrower than "we don't extract".
 *
 * We are on 0.6.1, which clears the advisories that were open against the
 * 0.5 line: GHSA-xcpc-8h2w-3j85 and then GHSA-7q85-xj36-vmfc, both
 * "uncontrolled allocation from a forged uncompressed-size header", fixed in
 * 0.6.0 and 0.6.1 respectively. It also leaves the range of
 * GHSA-vwc7-r8mq-g2x9 (symlink-following overwrite on extract), which is
 * `>= 0.5.9, <= 0.6.0` and still has no fixed release — we are past it rather
 * than patched against it.
 *
 * Keep the write-only property anyway. The allocation advisories arrived
 * twice in the same shape, so a third is a reasonable expectation, and they
 * fire on `readFile`, `readAsText`, `entry.getData()` and `test()` — anything
 * that parses an archive, not just extraction. Nothing here hands adm-zip
 * bytes it did not just produce, which is what makes a future advisory of
 * that family a version bump rather than an incident. Adding a read-untrusted
 * path would change that; use a different library for it.
 *
 * The tests do call `new AdmZip(buffer)`, and `readAsText`, `getEntries` and
 * one `extractAllTo` — but only on archives they just built themselves.
 *
 * One thing this does *not* claim: that Kady never touches an untrusted zip.
 * A user can drop one in the sandbox and ask the agent to open it. That read
 * happens inside the sandbox with the agent's own tools — `unzip`, Python's
 * `zipfile` — which are not this dependency and carry their own risk. The
 * claim here is only about adm-zip's reachability from server code, and the
 * paths that could have broken it do not: `/sandbox/upload`
 * (`api/sandbox.ts:265`) writes the bytes it receives without unpacking them,
 * `project-archive.ts` builds archives with `archiver`, and `skills-fetch.ts`
 * shells out to a fetcher rather than parsing an archive in process. If a
 * server route ever parses a user-supplied archive, check what it parses it
 * with before assuming this paragraph still covers it.
 */
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { isWithin, isUserVisible } from "../sandbox-fs.ts";
import { notebookToMarkdown } from "./notebook-export.ts";
import type { NotebookAnnotation } from "./notebook-annotations.ts";
import type { NotebookEntry } from "./notebook-store.ts";

export interface NotebookZipResult {
  buffer: Buffer;
  missing: string[];
}

/** Wire paths are already forward-slash; normalize defensively for old rows. */
function normalizeRel(rel: string): string {
  return rel.replaceAll("\\", "/").replace(/^\/+/, "");
}

export function buildNotebookZip(
  entries: NotebookEntry[],
  opts: {
    /** Session-scope export only; omit for a project-scope bundle. */
    sessionId?: string;
    projectName?: string;
    sandboxRoot: string;
    annotations?: readonly NotebookAnnotation[];
    /** Project-scope export: session id → label, grouping the markdown. */
    sessionLabels?: ReadonlyMap<string, string>;
  },
): NotebookZipResult {
  const zip = new AdmZip();
  const missing = new Set<string>();
  const bundled = new Map<string, string>(); // original rel → abs path
  for (const e of entries) {
    for (const p of e.artifacts ?? []) {
      if (bundled.has(p) || missing.has(p)) continue;
      const abs = path.resolve(opts.sandboxRoot, normalizeRel(p));
      let ok = false;
      try {
        const realRoot = fs.realpathSync(opts.sandboxRoot);
        const real = fs.realpathSync(abs);
        ok = isWithin(opts.sandboxRoot, abs) && isUserVisible(abs, opts.sandboxRoot)
          && isWithin(realRoot, real) && isUserVisible(real, realRoot) && fs.statSync(real).isFile();
      } catch {
        ok = false;
      }
      if (ok) bundled.set(p, abs);
      else missing.add(p);
    }
  }
  for (const [rel, abs] of bundled) {
    const archived = "artifacts/" + normalizeRel(rel);
    zip.addLocalFile(abs, path.posix.dirname(archived), path.posix.basename(archived));
  }
  const md = notebookToMarkdown(entries, {
    sessionId: opts.sessionId,
    projectName: opts.projectName,
    annotations: opts.annotations,
    sessionLabels: opts.sessionLabels,
    artifactHref: (p) => (bundled.has(p) ? "artifacts/" + normalizeRel(p) : undefined),
    missingArtifacts: missing,
  });
  zip.addFile("lab-notebook.md", Buffer.from(md, "utf-8"));
  return { buffer: zip.toBuffer(), missing: [...missing] };
}
