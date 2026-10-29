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
 * - When the unbundled entry cannot even be resolved (or, on POSIX, the
 *   launcher entry cannot be resolved), setup throws: startup must fail
 *   clearly rather than run probes on an unverified runtime. The error
 *   names the explicit-override escape hatch.
 *
 * Platform notes (`getPiSpawnCommand` semantics, verified against the
 * installed pi-subagents):
 * - Windows, JS entry: spawned as `process.execPath + [entry, ...args]` —
 *   always the running (policy-checked) Node. Nothing to do, so on Windows
 *   the seam points directly at the unbundled entry.
 * - POSIX: the entry is executed directly. Pointing the seam at a shell
 *   script would still resolve its interpreter through PATH, so Kady ships
 *   its own tiny launcher (`scripts/kady-pi.sh`, no Pi code in it) and the
 *   seam points there instead. The launcher `exec`s the exact backend
 *   `process.execPath` and the unbundled CLI from explicitly populated
 *   environment variables (`KADY_NODE_BIN`, `KADY_PI_CLI`) — no PATH lookup
 *   anywhere on the path, no shell interpolation (`"$@"` preserves quoting
 *   and spacing), and `exec` means signals and the exit status belong to the
 *   real CLI with no intermediary to forward through.
 *
 * Tradeoffs, recorded not signed off: `KADY_NODE_BIN`/`KADY_PI_CLI` live in
 * the backend process environment alongside everything child processes
 * already inherit, so they grant no new capability to anything that can
 * already write the backend's env. An unresolvable launcher falls back to
 * throwing, not to the bundled CLI. A missing/unexecutable entry at probe
 * time degrades to a loud, visible probe error. `process.env` itself is
 * never rewritten except for the seam variable (and, on POSIX
 * kady-default, the two launcher variables) — notably PATH is left
 * byte-for-byte alone.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Env var pi-subagents reads in `getPiSpawnCommand`. */
export const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";
/** Env var naming the exact Node binary the Kady launcher must exec. */
export const KADY_NODE_BIN_ENV = "KADY_NODE_BIN";
/** Env var naming the unbundled Pi CLI entry the Kady launcher must run. */
export const KADY_PI_CLI_ENV = "KADY_PI_CLI";

/** Return false for missing paths and non-files. */
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

/** Absolute path of the Kady-owned POSIX launcher script. */
export function kadyPiLauncherPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "scripts",
    "kady-pi.sh",
  );
}

export type PiBinarySetupAction = "operator" | "kady-default";

export interface PiBinarySetup {
  /** What was decided: operator override kept, or Kady default applied. */
  action: PiBinarySetupAction;
  /** The value now in `env[PI_SUBAGENT_PI_BINARY_ENV]`. */
  value: string;
  /** Precise, actionable defects (missing/non-executable entry or launcher). Never silent. */
  warnings: string[];
}

export interface KadyPiBinaryInputs {
  /** Resolved unbundled `dist/cli.js` (null when unresolvable). */
  unbundledEntry: string | null | undefined;
  /** Resolved Kady launcher script (null when unresolvable; unused on Windows). */
  launcherEntry: string | null | undefined;
  platform?: NodeJS.Platform;
  execPath?: string;
}

/**
 * Apply the seam decision to a mutable env record (normally
 * `process.env`). Testable without touching the real environment; the
 * wiring in session-registry passes `process.env`.
 *
 * Throws (fail startup clearly) when the unbundled entry cannot be resolved
 * at all, or — on POSIX only — when the launcher entry cannot be resolved.
 * Never leaves the seam unset for the plugin default.
 */
export function setupKadyPiBinary(
  env: NodeJS.ProcessEnv,
  inputs: KadyPiBinaryInputs,
): PiBinarySetup {
  const platform = inputs.platform ?? process.platform;
  const execPath = inputs.execPath ?? process.execPath;
  const existing = env[PI_SUBAGENT_PI_BINARY_ENV]?.trim();
  if (existing) {
    // Explicit user-controlled exception: verbatim, nothing else touched.
    return { action: "operator", value: existing, warnings: [] };
  }
  const unbundledEntry = inputs.unbundledEntry;
  if (typeof unbundledEntry !== "string" || unbundledEntry.length === 0) {
    throw new Error(
      "could not resolve the installed unbundled Pi CLI; refusing to fall back to the " +
        "bundled CLI. Set PI_SUBAGENT_PI_BINARY explicitly to a Pi CLI entry to proceed.",
    );
  }
  if (platform !== "win32") {
    const launcherEntry = inputs.launcherEntry;
    if (typeof launcherEntry !== "string" || launcherEntry.length === 0) {
      throw new Error(
        "could not resolve the Kady Pi launcher script; refusing to fall back to the " +
          "bundled CLI. Set PI_SUBAGENT_PI_BINARY explicitly to a Pi CLI entry to proceed.",
      );
    }
    // Always configured — even missing or non-executable — so a probe attempt
    // fails visibly instead of reverting to the bundle.
    env[PI_SUBAGENT_PI_BINARY_ENV] = launcherEntry;
    env[KADY_NODE_BIN_ENV] = execPath;
    env[KADY_PI_CLI_ENV] = unbundledEntry;
    const warnings: string[] = [];
    if (!isFile(launcherEntry)) {
      warnings.push(
        `PI_SUBAGENT_PI_BINARY is set to ${launcherEntry}, but that launcher file does not exist; ` +
          "profile model probes will fail visibly instead of using the bundled CLI.",
      );
    } else if (!isLaunchable(launcherEntry, platform)) {
      warnings.push(
        `PI_SUBAGENT_PI_BINARY is set to ${launcherEntry}, but that launcher file is not executable; ` +
          "profile model probes will fail visibly instead of using the bundled CLI.",
      );
    }
    if (!isFile(unbundledEntry)) {
      warnings.push(
        `KADY_PI_CLI is set to ${unbundledEntry}, but that file does not exist; ` +
          "profile model probes will fail visibly instead of using the bundled CLI.",
      );
    }
    return { action: "kady-default", value: launcherEntry, warnings };
  }
  env[PI_SUBAGENT_PI_BINARY_ENV] = unbundledEntry;
  const warnings: string[] = [];
  if (!isFile(unbundledEntry)) {
    warnings.push(
      `PI_SUBAGENT_PI_BINARY is set to ${unbundledEntry}, but that file does not exist; ` +
        "profile model probes will fail visibly instead of using the bundled CLI.",
    );
  }
  return { action: "kady-default", value: unbundledEntry, warnings };
}
