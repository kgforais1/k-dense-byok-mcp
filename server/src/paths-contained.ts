import path from "node:path";

/**
 * Join `name` onto `root` and prove the result stayed inside it.
 *
 * The name is resolved as given and the result refused if it escapes, rather
 * than reduced to its last segment first. Reducing is tempting because it
 * always yields something usable, but that is the problem: handed
 * `../../etc/passwd` it would quietly retarget a delete at `<root>/passwd`,
 * destroying a real file nobody asked about and hiding the upstream validation
 * bug that let the name through. Failing closed leaves the caller's mistake
 * visible.
 *
 * Every caller already rejects a session id that could traverse, so this never
 * fires at runtime. It is here for two things a validity predicate a few lines
 * up cannot give: it keeps the containment beside the path that reaches the
 * filesystem, where a later edit cannot drift away from it, and it is the form
 * static analysis can follow — CodeQL does not treat a user-defined
 * `isValidSessionId` as a barrier, and reported these joins as path injection
 * until the check moved here.
 *
 * `headless-sessions.ts` and `cost/ledger.ts` already do exactly this inline.
 */
export function containedIn(root: string, name: string): string {
  const base = path.resolve(root);
  // `path.resolve` discards every earlier argument once it meets an absolute
  // one, so an absolute `name` never touches `root` at all. Today that name
  // still has to land inside `base` to survive the check below, but one that
  // happened to would be returned without ever having been joined — the
  // caller would believe it had pinned a name under its own directory when
  // the name had chosen the whole path. `name` is a filename here, never a
  // path, so refusing outright costs nothing.
  if (path.isAbsolute(name)) {
    throw new Error("Refusing an absolute name");
  }
  const resolved = path.resolve(base, name);
  // `base` already ends in a separator when it is a filesystem root, and
  // doubling it there would reject every name under it.
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  // `resolved === base` is its own case, not a prefix question. At a
  // filesystem root the base *is* the prefix, so `.` and `..` both collapse
  // onto it and would pass the test below — naming the root directory itself
  // where a name inside it was asked for.
  if (resolved === base || !resolved.startsWith(prefix)) {
    // Neither the root nor the name is named. The root is an absolute host
    // path, and a relative name can still spell one out — `../../tmp/x` holds
    // a host directory in it. `mcp-adapter-guardrails.test.ts` asserts no tool
    // result carries such a path, and an error message is a leak surface like
    // any other. No caller can reach this today; the caller's own logs have
    // the name.
    throw new Error("Refusing a path outside the root");
  }
  return resolved;
}
