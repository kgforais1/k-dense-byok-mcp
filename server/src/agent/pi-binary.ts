/**
 * Pi CLI binary selection for pi-subagents' `PI_SUBAGENT_PI_BINARY` seam.
 *
 * pi-subagents resolves the `pi` CLI it spawns for profile model probes
 * through `getPiSpawnCommand`, which honours `PI_SUBAGENT_PI_BINARY` before
 * falling back to the installed package `bin` — the *bundled*
 * `dist/bundle/cli.js` with its inlined undici copy. Kady points the seam at
 * the installed *unbundled* `dist/cli.js` instead, which loads the
 * npm-resolved (override-pinned) undici through Pi's own dispatcher setup.
 * Ordinary foreground/background subagent runs never consult this variable,
 * so they are unaffected.
 *
 * Fail-safe rules (no silent revert to the bundled CLI, ever):
 * - An explicit non-blank operator override wins verbatim and disables all
 *   other handling: the operator owns that choice, including its risk.
 * - Otherwise the resolved unbundled entry is ALWAYS configured, even when
 *   the file is missing or not executable: a probe attempt then fails
 *   visibly (spawn error → probe `error` status) instead of silently
 *   executing the known-vulnerable bundle. The precise defect is reported
 *   in `warnings`.
 * - When the entry path cannot even be resolved, or when (POSIX) no PATH
 *   entry can aim the entry's `env node` shebang at the verified backend
 *   Node, setup throws: startup must fail clearly rather than run probes
 *   on an unverified runtime. The error names the explicit-override escape
 *   hatch.
 *
 * Platform notes (`getPiSpawnCommand` semantics, verified against the
 * installed pi-subagents):
 * - Windows, JS entry: spawned as `process.execPath + [entry, ...args]` —
 *   always the running (policy-checked) Node. Nothing to do.
 * - POSIX: the entry is executed directly, so its `#!/usr/bin/env node`
 *   shebang resolves `node` through PATH. For the Kady default (only), the
 *   service's own Node directory is moved to the PATH front — every other
 *   entry (including `.bin` and meaningful empty segments, which spell the
 *   current directory on POSIX) is preserved in order, never duplicated,
 *   never dropped; only exact duplicates of the service directory are
 *   removed. An absent or empty PATH becomes exactly the service directory.
 *
 * Tradeoff of the PATH move: it applies process-wide, so every backend
 * child spawn (agent `bash`, npm scripts, tool helpers) resolves `node` to
 * the guarded backend binary instead of the PATH lottery. That is the
 * point — one verified runtime everywhere — at the cost that an operator
 * PATH customization naming a different `node` no longer wins inside
 * backend children (absolute paths still work; an explicit
 * PI_SUBAGENT_PI_BINARY also skips the move entirely).
 */
import fs from "node:fs";
import path from "node:path";

/** Env var pi-subagents reads in `getPiSpawnCommand`. */
export const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";

function isFile(entry: string): boolean {
  try {
    return fs.statSync(entry).isFile();
  } catch {
    return false;
  }
}

/** Whether `entry` can be launched directly on this platform. */
function isLaunchable(entry: string, platform: NodeJS.Platform): boolean {
  if (!isFile(entry)) return false;
  if (platform === "win32") return true;
  try {
    fs.accessSync(entry, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export type PiBinarySetupAction = "operator" | "kady-default";

export interface PiBinarySetup {
  /** What was decided: operator override kept, or Kady default applied. */
  action: PiBinarySetupAction;
  /** The value now in `env[PI_SUBAGENT_PI_BINARY_ENV]`. */
  value: string;
  /** True when the service Node directory was moved to the front of PATH. */
  pathPrepended: boolean;
  /** Precise, actionable defects (missing/non-executable entry). Never silent. */
  warnings: string[];
}

/**
 * Apply the seam decision to a mutable env record (normally
 * `process.env`). Testable without touching the real environment; the
 * wiring in session-registry passes `process.env`.
 *
 * Throws (fail startup clearly) when the entry cannot be resolved at all,
 * or when on POSIX no PATH entry can aim the shebang at the verified
 * backend Node. Never leaves the seam unset for the plugin default.
 */
export function setupKadyPiBinary(
  env: NodeJS.ProcessEnv,
  unbundledEntry: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): PiBinarySetup {
  const existing = env[PI_SUBAGENT_PI_BINARY_ENV]?.trim();
  if (existing) {
    // Explicit user-controlled exception: verbatim, PATH untouched.
    return { action: "operator", value: existing, pathPrepended: false, warnings: [] };
  }
  if (typeof unbundledEntry !== "string" || unbundledEntry.length === 0) {
    throw new Error(
      "could not resolve the installed unbundled Pi CLI; refusing to fall back to the " +
        "bundled CLI. Set PI_SUBAGENT_PI_BINARY explicitly to a Pi CLI entry to proceed.",
    );
  }
  if (platform !== "win32") {
    // Verified before mutating anything: only a PATH entry resolving to the
    // exact backend binary may aim the entry's `env node` shebang.
    const nodeDir = path.dirname(execPath);
    let verified = false;
    try {
      verified = fs.realpathSync(path.join(nodeDir, "node")) === fs.realpathSync(execPath);
    } catch {
      verified = false;
    }
    if (!verified) {
      throw new Error(
        `no PATH entry resolves to the verified backend Node (${execPath}); refusing to run ` +
          "profile probes on an unverified runtime. Set PI_SUBAGENT_PI_BINARY explicitly to a " +
          "Pi CLI entry to proceed.",
      );
    }
  }
  // Always configure the resolved path — even missing or non-executable — so
  // a probe attempt fails visibly instead of reverting to the bundle.
  env[PI_SUBAGENT_PI_BINARY_ENV] = unbundledEntry;
  const warnings: string[] = [];
  if (!isFile(unbundledEntry)) {
    warnings.push(
      `PI_SUBAGENT_PI_BINARY is set to ${unbundledEntry}, but that file does not exist; ` +
        "profile model probes will fail visibly instead of using the bundled CLI.",
    );
  } else if (!isLaunchable(unbundledEntry, platform)) {
    warnings.push(
      `PI_SUBAGENT_PI_BINARY is set to ${unbundledEntry}, but that file is not executable; ` +
        "profile model probes will fail visibly instead of using the bundled CLI.",
    );
  }
  if (platform === "win32") {
    return { action: "kady-default", value: unbundledEntry, pathPrepended: false, warnings };
  }
  const nodeDir = path.dirname(execPath);
  // Move only the service directory: drop its exact duplicates, keep every
  // other segment — including meaningful empty ones (current directory on
  // POSIX) — in order. An absent PATH becomes exactly the service directory;
  // an explicitly empty PATH keeps its one empty segment after it.
  const current = typeof env.PATH === "string" ? env.PATH.split(path.delimiter) : [];
  const rest = current.filter((segment) => segment !== nodeDir);
  env.PATH = [nodeDir, ...rest].join(path.delimiter);
  return { action: "kady-default", value: unbundledEntry, pathPrepended: true, warnings };
}
