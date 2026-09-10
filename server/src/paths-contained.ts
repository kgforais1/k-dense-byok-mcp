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
  const resolved = path.resolve(base, name);
  // `base` already ends in a separator when it is a filesystem root, and
  // doubling it there would reject every name under it.
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  // `resolved === base` is its own case, not a prefix question. At a
  // filesystem root the base *is* the prefix, so `.` and `..` both collapse
  // onto it and would pass the test below — naming the root directory itself
  // where a name inside it was asked for.
  if (resolved === base || !resolved.startsWith(prefix)) {
    throw new Error(`Refusing a path outside ${base}`);
  }
  return resolved;
}
