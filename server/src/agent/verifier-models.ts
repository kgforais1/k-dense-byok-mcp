// FORK: check required values at runtime instead of asserting away nullability.
import { required as requireValue } from "../required.ts";
/**
 * Verifier model routing (Settings → Defaults → Verifier model).
 *
 * Specialists that check other agents' work (the `verifier` personas in
 * subagents.ts plus pi-subagents' builtin `reviewer` and `evidence-auditor`)
 * can run on a different model than the one that produced the work, so a
 * reviewer does not share its author's blind spots.
 *
 * The routing has to reach every way a child is launched: structured
 * `{ agent, task }` calls, workflow scripts (whose children live in source
 * text Kady cannot rewrite, and run in a detached runner) and schedule fires.
 * The only lever pi-subagents resolves per child in all of those is
 * `subagents.agentOverrides.<name>.model` in the project's `.pi/settings.json`,
 * so the app-wide default is projected into each project as those entries.
 *
 * Kady owns only the entries it wrote. The sidecar `.kady/verifier-models.json`
 * records them; an entry whose value no longer matches (the user edited or
 * removed it) is released and never touched again. pi-subagents applies an
 * override *over* agent frontmatter, so a verifier whose definition pins its
 * own model gets no entry: its own choice stays authoritative. A
 * project-level `subagents.defaultModel` is weaker than an override, so the
 * verifier model wins over it, which is the point of setting one.
 *
 * Reconciled on every session build, before every delegation (bridge
 * `tool_call` hook, so a disconnected provider or a newly pinned frontmatter
 * model takes effect before the launch), and for every project when the
 * default changes. A malformed settings file is never rewritten.
 */
import fs from "node:fs";
import path from "node:path";
import type { ProjectPaths } from "../projects.ts";
import { atomicJson } from "../atomic-json.ts";
import { readAppDefaults } from "../app-settings.ts";
import { piSettingsPath, writePiSettings } from "./capability-state.ts";
import { listAgents } from "./agent-files.ts";
import { normalizeModelRef } from "./models.ts";
import { SUBAGENT_TYPES } from "./subagents.ts";

/** pi-subagents builtins that review rather than produce. */
export const BUILTIN_VERIFIER_AGENTS = ["reviewer", "evidence-auditor"] as const;

/** Every specialist name the verifier model applies to. */
export function verifierAgentNames(): string[] {
  return [...SUBAGENT_TYPES.filter((type) => type.verifier).map((type) => type.name), ...BUILTIN_VERIFIER_AGENTS];
}

const VERIFIER_NAMES = new Set(verifierAgentNames());

export function isVerifierAgent(name: string): boolean {
  return VERIFIER_NAMES.has(name);
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function sidecarPath(paths: ProjectPaths): string {
  return path.join(paths.kadyDir, "verifier-models.json");
}

/** Recover ownership from a write-ahead record without claiming user edits. */
function readOwnership(paths: ProjectPaths): { owned: Record<string, string>; pending: boolean } {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(sidecarPath(paths), "utf-8"));
    const before = isRecord(parsed) && isRecord(parsed.owned) ? parsed.owned : {};
    const pending = isRecord(parsed) && isRecord(parsed.pending);
    if (!pending) {
      return { owned: Object.fromEntries(Object.entries(before).filter((entry): entry is [string, string] => typeof entry[1] === "string")), pending: false };
    }
    // FORK: either settings version may be on disk after an interrupted write.
    // Only the recorded before/after values are ours; any other edit stays user-owned.
    const after = parsed.pending as Rec;
    const settings: unknown = JSON.parse(fs.readFileSync(piSettingsPath(paths), "utf-8"));
    const subagents = isRecord(settings) && isRecord(settings.subagents) ? settings.subagents : {};
    const overrides = isRecord(subagents.agentOverrides) ? subagents.agentOverrides : {};
    const owned: Record<string, string> = {};
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const entry = overrides[name];
      const current = isRecord(entry) ? entry.model : undefined;
      if (typeof current === "string" && (current === before[name] || current === after[name])) owned[name] = current;
    }
    return { owned, pending: true };
  } catch {
    return { owned: {}, pending: false };
  }
}

export interface VerifierReconcileResult {
  /** The settings file was rewritten. */
  changed: boolean;
  /** Verifiers now routed to the verifier model by Kady. */
  routed: string[];
  /** Why nothing could be applied, when that is the case. */
  skipped?: "malformed-settings" | "unavailable";
}

/**
 * Project the verifier model into one project's agent overrides.
 *
 * `verifierModel` undefined (not set) removes every entry Kady owns.
 * `isAvailable` says whether the model can run now (resolves, provider
 * connected); an unavailable model is treated like an unset one, so verifiers
 * fall back to their usual model instead of failing at launch.
 *
 * A project without a settings file has never had a session built; it is
 * left untouched (its first session build reconciles it) unless
 * `createSettings` asks for the file, as listing its specialists does.
 */
export function reconcileVerifierModels(
  paths: ProjectPaths,
  verifierModel: string | undefined,
  isAvailable: (ref: string) => boolean = (_ref: string) => true,
  { createSettings = false }: { createSettings?: boolean } = {},
): VerifierReconcileResult {
  let settings: Rec;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(piSettingsPath(paths), "utf-8"));
    if (!isRecord(parsed)) return { changed: false, routed: [], skipped: "malformed-settings" };
    settings = parsed;
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== "ENOENT") return { changed: false, routed: [], skipped: "malformed-settings" };
    if (!createSettings) return { changed: false, routed: [] };
    settings = {};
  }
  const subagents = isRecord(settings.subagents) ? { ...settings.subagents } : {};
  if (subagents.agentOverrides !== undefined && !isRecord(subagents.agentOverrides)) {
    return { changed: false, routed: [], skipped: "malformed-settings" };
  }
  const overrides: Rec = { ...((subagents.agentOverrides as Rec | undefined) ?? {}) };
  const { owned, pending } = readOwnership(paths);
  const nextOwned: Record<string, string> = {};
  // FORK: project a canonical Azure ref. pi-subagents reads this override
  // straight from `.pi/settings.json` and cannot alias Pi 1.1's renamed
  // `azure-openai-responses` provider, so Kady must write the canonical id.
  const configuredModel = verifierModel !== undefined ? normalizeModelRef(verifierModel) : undefined;
  const available = Boolean(configuredModel) && isAvailable(requireValue(configuredModel));
  const desired = available ? configuredModel : undefined;
  const agents = new Map(listAgents(paths).map((agent) => [agent.name, agent] as const));
  let changed = false;

  for (const name of new Set([...verifierAgentNames(), ...Object.keys(owned)])) {
    const entry = overrides[name];
    if (entry !== undefined && !isRecord(entry)) continue; // malformed user entry
    const current = isRecord(entry) ? entry.model : undefined;
    const ownedValue = owned[name];
    // Released: the user changed or removed what Kady wrote.
    if (ownedValue !== undefined && current !== ownedValue) continue;
    const isOwned = ownedValue !== undefined;
    // The user's own override (a model, or `false` to clear one) wins.
    if (!isOwned && current !== undefined) continue;
    const want = desired && isVerifierAgent(name) && agents.has(name) && !requireValue(agents.get(name)).model ? desired : undefined;
    if (want) {
      nextOwned[name] = want;
      if (current !== want) {
        overrides[name] = { ...(entry ?? {}), model: want };
        changed = true;
      }
    } else if (isOwned) {
      const { model: _model, ...rest } = entry ?? {};
      if (Object.keys(rest).length > 0) overrides[name] = rest;
      else delete overrides[name];
      changed = true;
    }
  }

  // FORK: explicit tuple-string comparator (typescript:S2871); a < b on tuples does not typecheck, and localeCompare would be locale-dependent.
  const ownedChanged = JSON.stringify(Object.entries(owned).sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))) !== JSON.stringify(Object.entries(nextOwned).sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)));
  if (changed) {
    if (Object.keys(overrides).length > 0) subagents.agentOverrides = overrides;
    else delete subagents.agentOverrides;
    const next: Rec = { ...settings, subagents };
    // Removing the last entry Kady wrote must not leave an empty block behind.
    if (Object.keys(subagents).length === 0) delete next.subagents;
    // FORK: persist both ownership states before settings. A retry can identify
    // either committed value if settings or the final sidecar write is interrupted.
    atomicJson(sidecarPath(paths), { version: 1, owned, pending: nextOwned });
    writePiSettings(paths, next);
  }
  if (changed || ownedChanged || pending) {
    if (Object.keys(nextOwned).length > 0) atomicJson(sidecarPath(paths), { version: 1, owned: nextOwned });
    else fs.rmSync(sidecarPath(paths), { force: true });
  }
  return {
    changed,
    // FORK: explicit code-unit comparator (typescript:S2871); localeCompare would be locale-dependent.
    routed: Object.keys(nextOwned).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ...(configuredModel && !available ? { skipped: "unavailable" as const } : {}),
  };
}

/** The verifiers Kady currently routes in this project, and their model. */
export function routedVerifiers(paths: ProjectPaths): { model: string; agents: string[] } | null {
  const { owned } = readOwnership(paths);
  // FORK: explicit code-unit comparator (typescript:S2871); localeCompare would be locale-dependent.
  const agents = Object.keys(owned).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const models = new Set(Object.values(owned));
  return agents.length > 0 && models.size === 1 ? { model: [...models][0], agents } : null;
}

/** Reconcile one project against the saved app default. Never throws. */
export function applyVerifierDefault(
  paths: ProjectPaths,
  isAvailable: (ref: string) => boolean,
  options?: { createSettings?: boolean },
): VerifierReconcileResult | null {
  try {
    return reconcileVerifierModels(paths, readAppDefaults().verifierModel, isAvailable, options);
  } catch (error) {
    // Routing is an optimization of who checks the work; a failure here must
    // never block a session build or a delegation.
    console.warn(`[verifier-models] ${paths.sandbox}: ${(error as Error).message}`);
    return null;
  }
}
