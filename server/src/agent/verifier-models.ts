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
 *
 * Inputs: project paths, the saved verifier model (or `undefined` to clear),
 * and an availability check. Output: whether settings changed, which verifiers
 * are routed, and why a projection was skipped. Requires a readable project
 * sandbox; a missing settings file is left alone unless `createSettings` is set.
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentFile } from "./agent-files.ts";
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

/** Keep string-valued ownership entries and drop anything else. */
function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/**
 * Read the sidecar shape. `pending` is present only for a write-ahead record
 * that has not been replaced by the final ownership file.
 */
function parseOwnershipFile(raw: unknown): { owned: Record<string, string>; pending: Rec | null } {
  if (!isRecord(raw)) return { owned: {}, pending: null };
  return { owned: stringMap(raw.owned), pending: isRecord(raw.pending) ? raw.pending : null };
}

/** Model currently stored on one agent override, when that entry is an object. */
function overrideModel(overrides: Rec, name: string): unknown {
  const entry = overrides[name];
  return isRecord(entry) ? entry.model : undefined;
}

/**
 * A settings value is still Kady's when it equals the ownership recorded
 * before the interrupted write or the value that write was about to commit.
 */
function recordedModel(current: unknown, previous: unknown, next: unknown): string | undefined {
  if (typeof current !== "string") return undefined;
  if (current === previous || current === next) return current;
  return undefined;
}

/** Claim only names whose on-disk model is one of the two recorded values. */
function claimedOwnership(overrides: Rec, before: Record<string, string>, after: Rec): Record<string, string> {
  const owned: Record<string, string> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const current = recordedModel(overrideModel(overrides, name), before[name], after[name]);
    if (current !== undefined) owned[name] = current;
  }
  return owned;
}

// FORK: either settings version may be on disk after an interrupted write.
// Only the recorded before/after values are ours; any other edit stays user-owned.
function recoverPendingOwnership(paths: ProjectPaths, before: Record<string, string>, after: Rec): Record<string, string> {
  const settings: unknown = JSON.parse(fs.readFileSync(piSettingsPath(paths), "utf-8"));
  const root = isRecord(settings) ? settings : {};
  const subagents = isRecord(root.subagents) ? root.subagents : {};
  const overrides = isRecord(subagents.agentOverrides) ? subagents.agentOverrides : {};
  return claimedOwnership(overrides, before, after);
}

/** Recover ownership from a write-ahead record without claiming user edits. */
function readOwnership(paths: ProjectPaths): { owned: Record<string, string>; pending: boolean } {
  try {
    const parsed = parseOwnershipFile(JSON.parse(fs.readFileSync(sidecarPath(paths), "utf-8")));
    if (!parsed.pending) return { owned: parsed.owned, pending: false };
    return { owned: recoverPendingOwnership(paths, parsed.owned, parsed.pending), pending: true };
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

/** Settings exist but cannot be projected, so the file is left untouched. */
function malformedSettings(): VerifierReconcileResult {
  return { changed: false, routed: [], skipped: "malformed-settings" };
}

type SettingsLoad = { ok: true; settings: Rec } | { ok: false; result: VerifierReconcileResult };

/** Load Pi settings, or say why this project should be left alone. */
function loadVerifierSettings(paths: ProjectPaths, createSettings: boolean): SettingsLoad {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(piSettingsPath(paths), "utf-8"));
    if (!isRecord(parsed)) return { ok: false, result: malformedSettings() };
    return { ok: true, settings: parsed };
  } catch (exc) {
    return missingSettings(exc, createSettings);
  }
}

/** A missing file is empty only when the caller asked to create one. */
function missingSettings(exc: unknown, createSettings: boolean): SettingsLoad {
  if ((exc as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, result: malformedSettings() };
  if (!createSettings) return { ok: false, result: { changed: false, routed: [] } };
  return { ok: true, settings: {} };
}

type OverrideCopy = { malformed: true } | { subagents: Rec; overrides: Rec };

/** Copy the override block. A non-object block is the user's malformed file. */
function copyOverrides(settings: Rec): OverrideCopy {
  const subagents = isRecord(settings.subagents) ? { ...settings.subagents } : {};
  const block = subagents.agentOverrides;
  if (block !== undefined && !isRecord(block)) return { malformed: true };
  return { subagents, overrides: { ...(isRecord(block) ? block : {}) } };
}

/** The user changed or removed the value Kady last wrote. */
function releasedByUser(ownedValue: string | undefined, current: unknown): boolean {
  return ownedValue !== undefined && current !== ownedValue;
}

/** An override Kady did not write, including `model: false`, stays put. */
function userOverrideWins(isOwned: boolean, current: unknown): boolean {
  return !isOwned && current !== undefined;
}

/** True when this specialist's own frontmatter already names a model. */
function hasOwnModel(agents: Map<string, AgentFile>, name: string): boolean {
  if (!agents.has(name)) return false;
  return Boolean(requireValue(agents.get(name)).model);
}

/**
 * Route this verifier only when it exists, does not pin a frontmatter model,
 * and a usable verifier model is configured.
 */
function desiredModel(name: string, desired: string | undefined, agents: Map<string, AgentFile>): string | undefined {
  if (!desired || !isVerifierAgent(name)) return undefined;
  if (!agents.has(name) || hasOwnModel(agents, name)) return undefined;
  return desired;
}

/** A non-object override is the user's data and is not rewritten. */
function malformedEntry(entry: unknown): boolean {
  return entry !== undefined && !isRecord(entry);
}

type AgentDecision =
  | { kind: "skip" }
  | { kind: "keep" }
  | { kind: "set"; want: string; entry: unknown; current: unknown }
  | { kind: "clear"; entry: unknown };

/** Decide one specialist without writing. Malformed entries are skipped. */
function decideAgent(
  name: string,
  overrides: Rec,
  owned: Record<string, string>,
  desired: string | undefined,
  agents: Map<string, AgentFile>,
): AgentDecision {
  const entry = overrides[name];
  const current = isRecord(entry) ? entry.model : undefined;
  const ownedValue = owned[name];
  if (skipAgent(entry, current, ownedValue)) return { kind: "skip" };
  const want = desiredModel(name, desired, agents);
  if (want) return { kind: "set", want, entry, current };
  if (ownedValue !== undefined) return { kind: "clear", entry };
  return { kind: "keep" };
}

/** Skip malformed entries, released ownership, and overrides Kady did not write. */
function skipAgent(entry: unknown, current: unknown, ownedValue: string | undefined): boolean {
  if (malformedEntry(entry)) return true;
  if (releasedByUser(ownedValue, current)) return true;
  return userOverrideWins(ownedValue !== undefined, current);
}

/** Write a projected model. Returns whether the override text changed. */
function applyDesired(overrides: Rec, name: string, entry: unknown, current: unknown, want: string): boolean {
  if (current === want) return false;
  overrides[name] = { ...(isRecord(entry) ? entry : {}), model: want };
  return true;
}

/** Drop one override name without deleting a computed key on the live object. */
function withoutOverride(overrides: Rec, name: string): Rec {
  return Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== name));
}

/** Remove Kady's model key, keeping any other keys the override still has. */
function clearOwned(overrides: Rec, name: string, entry: unknown): Rec {
  const source = isRecord(entry) ? entry : {};
  const rest = Object.fromEntries(Object.entries(source).filter(([key]) => key !== "model"));
  if (Object.keys(rest).length > 0) return { ...overrides, [name]: rest };
  return withoutOverride(overrides, name);
}

/** Apply one decision. Returns the override map to keep, which may be a new object. */
function applyDecision(
  overrides: Rec,
  nextOwned: Record<string, string>,
  name: string,
  decision: AgentDecision,
): { changed: boolean; overrides: Rec } {
  if (decision.kind === "set") {
    nextOwned[name] = decision.want;
    return {
      changed: applyDesired(overrides, name, decision.entry, decision.current, decision.want),
      overrides,
    };
  }
  if (decision.kind === "clear") return { changed: true, overrides: clearOwned(overrides, name, decision.entry) };
  return { changed: false, overrides };
}

/** Project every verifier, plus any name Kady still owns from an older roster. */
function projectVerifierOverrides(
  overrides: Rec,
  owned: Record<string, string>,
  desired: string | undefined,
  agents: Map<string, AgentFile>,
): { changed: boolean; nextOwned: Record<string, string>; overrides: Rec } {
  const nextOwned: Record<string, string> = {};
  let changed = false;
  let current = overrides;
  for (const name of new Set([...verifierAgentNames(), ...Object.keys(owned)])) {
    const applied = applyDecision(current, nextOwned, name, decideAgent(name, current, owned, desired, agents));
    current = applied.overrides;
    if (applied.changed) changed = true;
  }
  return { changed, nextOwned, overrides: current };
}

/** Write the override block, or remove it when the projection left nothing. */
function assignOverrides(subagents: Rec, overrides: Rec): void {
  if (Object.keys(overrides).length > 0) subagents.agentOverrides = overrides;
  else delete subagents.agentOverrides;
}

/** Drop a subagents block that would otherwise be left empty. */
function withoutEmptySubagents(settings: Rec, subagents: Rec): Rec {
  const next: Rec = { ...settings, subagents };
  if (Object.keys(subagents).length === 0) delete next.subagents;
  return next;
}

/** Replace the sidecar with the committed ownership, or remove it when nothing is owned. */
function writeFinalOwnership(paths: ProjectPaths, nextOwned: Record<string, string>): void {
  if (Object.keys(nextOwned).length > 0) atomicJson(sidecarPath(paths), { version: 1, owned: nextOwned });
  else fs.rmSync(sidecarPath(paths), { force: true });
}

interface ProjectionCommit {
  paths: ProjectPaths;
  settings: Rec;
  subagents: Rec;
  overrides: Rec;
  owned: Record<string, string>;
  nextOwned: Record<string, string>;
  changed: boolean;
  pending: boolean;
  ownedChanged: boolean;
}

// FORK: persist both ownership states before settings. A retry can identify
// either committed value if settings or the final sidecar write is interrupted.
function commitVerifierProjection(commit: ProjectionCommit): void {
  if (commit.changed) {
    assignOverrides(commit.subagents, commit.overrides);
    atomicJson(sidecarPath(commit.paths), { version: 1, owned: commit.owned, pending: commit.nextOwned });
    writePiSettings(commit.paths, withoutEmptySubagents(commit.settings, commit.subagents));
  }
  if (commit.changed || commit.ownedChanged || commit.pending) writeFinalOwnership(commit.paths, commit.nextOwned);
}

/** Order ownership keys by UTF-16 code unit, independent of locale. */
function codeUnitOrder(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Sort ownership entries by their agent name. */
function entryOrder(left: [string, string], right: [string, string]): number {
  return codeUnitOrder(left[0], right[0]);
}

/** True when both maps contain the same agent names and model refs. */
function sameOwnership(left: Record<string, string>, right: Record<string, string>): boolean {
  return JSON.stringify(Object.entries(left).sort(entryOrder)) === JSON.stringify(Object.entries(right).sort(entryOrder));
}

/** Canonical Azure ref, or nothing when the default is unset. */
function configuredVerifier(verifierModel: string | undefined): string | undefined {
  if (verifierModel === undefined) return undefined;
  // FORK: project a canonical Azure ref. pi-subagents reads this override
  // straight from `.pi/settings.json` and cannot alias Pi 1.1's renamed
  // `azure-openai-responses` provider, so Kady must write the canonical id.
  return normalizeModelRef(verifierModel);
}

/** An unset model is unavailable. A configured one uses the caller's check. */
function verifierIsAvailable(configured: string | undefined, isAvailable: (ref: string) => boolean): boolean {
  if (!configured) return false;
  return isAvailable(configured);
}

/** Build the public result, including the unavailable skip when a model cannot run. */
function reconcileResult(
  changed: boolean,
  nextOwned: Record<string, string>,
  configured: string | undefined,
  available: boolean,
): VerifierReconcileResult {
  const result: VerifierReconcileResult = { changed, routed: Object.keys(nextOwned).sort(codeUnitOrder) };
  if (configured && !available) result.skipped = "unavailable";
  return result;
}

/** The model to project, or nothing when it cannot run right now. */
function activeVerifier(configured: string | undefined, available: boolean): string | undefined {
  if (!available) return undefined;
  return configured;
}

/** Apply one projection after defaults have been filled in. */
function projectVerifierModel(
  paths: ProjectPaths,
  verifierModel: string | undefined,
  isAvailable: (ref: string) => boolean,
  createSettings: boolean,
): VerifierReconcileResult {
  const loaded = loadVerifierSettings(paths, createSettings);
  if (!loaded.ok) return loaded.result;
  const copied = copyOverrides(loaded.settings);
  if ("malformed" in copied) return malformedSettings();
  const { owned, pending } = readOwnership(paths);
  const configured = configuredVerifier(verifierModel);
  const available = verifierIsAvailable(configured, isAvailable);
  const agents = new Map(listAgents(paths).map((agent) => [agent.name, agent] as const));
  const projected = projectVerifierOverrides(copied.overrides, owned, activeVerifier(configured, available), agents);
  commitVerifierProjection({
    paths,
    settings: loaded.settings,
    subagents: copied.subagents,
    overrides: projected.overrides,
    owned,
    nextOwned: projected.nextOwned,
    changed: projected.changed,
    pending,
    ownedChanged: !sameOwnership(owned, projected.nextOwned),
  });
  return reconcileResult(projected.changed, projected.nextOwned, configured, available);
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
  return projectVerifierModel(paths, verifierModel, isAvailable, createSettings);
}

/** The verifiers Kady currently routes in this project, and their model. */
export function routedVerifiers(paths: ProjectPaths): { model: string; agents: string[] } | null {
  const { owned } = readOwnership(paths);
  const agents = Object.keys(owned).sort(codeUnitOrder);
  const models = [...new Set(Object.values(owned))];
  if (agents.length === 0 || models.length !== 1) return null;
  return { model: models[0], agents };
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
