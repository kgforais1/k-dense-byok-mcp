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
 * adm-zip's open advisories split two ways. GHSA-vwc7-r8mq-g2x9
 * (CVE-2026-76845, symlink-following overwrite) is extraction-only, and has
 * **no fixed release at all** — 0.6.0 is inside its range. GHSA-xcpc-8h2w-3j85
 * (4 GB allocation from a forged uncompressed-size header) is *not*: it fires
 * on `readFile`, `readAsText`, `entry.getData()` and `test()` as well, so any
 * code that so much as parses an untrusted archive is exposed.
 *
 * So the safe property is that nothing here ever hands adm-zip bytes it did
 * not just produce. Reading an uploaded or downloaded zip would be a live
 * DoS, and adding an extract path would inherit a dependency with no patch
 * available. Use a different library for either. The dismissed Dependabot
 * alerts rest on this paragraph; revisit them if it stops being true.
 *
 * The tests do call `new AdmZip(buffer)`, but only on buffers they just
 * built here.
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
import { isWithin } from "../sandbox-fs.ts";
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
        ok = isWithin(opts.sandboxRoot, abs) && fs.statSync(abs).isFile();
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
