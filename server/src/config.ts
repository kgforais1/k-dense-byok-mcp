/**
 * Process-wide configuration: directories, ports, and env-derived knobs.
 *
 * The TS backend replaces the Python FastAPI + ADK server. It keeps the same
 * on-disk `projects/` layout (so existing user data is preserved) but drops the
 * Gemini-CLI / LiteLLM / MCP machinery.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Repo root = parent of `server/`. */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Root that holds every project directory. Overridable for tests. */
export const PROJECTS_ROOT = path.resolve(
  process.env.KADY_PROJECTS_ROOT
    ? process.env.KADY_PROJECTS_ROOT
    : path.join(REPO_ROOT, "projects"),
);

/** App-scoped Pi configuration/auth directory, established by env.ts. */
const rawPiAgentDir =
  process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".kady", "pi-agent");
export const KADY_PI_AGENT_DIR = path.resolve(
  rawPiAgentDir === "~"
    ? os.homedir()
    : rawPiAgentDir.startsWith("~/") || rawPiAgentDir.startsWith("~\\")
      ? path.join(os.homedir(), rawPiAgentDir.slice(2))
      : rawPiAgentDir,
);

/**
 * Default skill catalogue. Lives here rather than in `agent/skills.ts` so the
 * CLI-backed fetcher can reference it without importing back into the module
 * that installs from it.
 */
export const SKILLS_REPO =
  process.env.KADY_SKILLS_REPO ?? "K-Dense-AI/scientific-agent-skills";
export const SKILLS_BRANCH = process.env.KADY_SKILLS_BRANCH ?? "main";

/**
 * Staging cache the `skills` CLI fetches into. Deliberately outside any
 * project sandbox: one download per source serves every project, and nothing
 * here is canonical — `skills-sync.ts` installs from it into the live skill
 * dirs and remains their only writer.
 */
export const KADY_SKILLS_CACHE_DIR = path.resolve(
  process.env.KADY_SKILLS_CACHE_DIR?.trim() ||
    path.join(os.homedir(), ".kady", "skills-cache"),
);

/**
 * FORK: refuse to hand a test run the real user directories.
 *
 * Sixty-three test files begin with `fs.rmSync(PROJECTS_ROOT, { recursive:
 * true, force: true })`, and `skills-install.test.ts` does the same to the
 * skills cache and two directories under `KADY_PI_AGENT_DIR`. That is safe
 * only because `server/vitest.config.ts` points all three at the OS temp dir —
 * and a vitest run that does not load that config gets the production defaults
 * instead. Running a test file from the repository root is enough to miss it:
 * there is no config there, so `vitest` uses its own defaults and the env
 * block never applies. The result is not a failing test. It is the user's
 * projects directory, sandboxes and venvs included, deleted in a `beforeEach`.
 *
 * That has already happened once here, on 2026-09-14: `projects/` was wiped
 * and left holding a project named `Observed` with a session directory called
 * `obs-1`, which are the fixture names in `test/session-observer.test.ts`.
 *
 * So `VITEST` — which vitest sets whether or not it found a config — turns a
 * production path into a startup error. The check is on the resolved value
 * rather than on whether the variable was set, because "set" is not the same
 * as "safe": `env.ts` assigns `PI_CODING_AGENT_DIR` the real `~/.kady/pi-agent`
 * when it is unset, so a presence check would accept it from anything that
 * imported `env.ts` first. Comparing paths covers that, covers a variable
 * deliberately pointed at real data, and still covers the unset case, which
 * resolves to the default by definition.
 *
 * Marked because `config.ts` is upstream-owned and this is an in-place
 * insertion, so a future `git merge upstream/main` has a seam to resolve
 * against. The block is self-contained: it reads three resolved paths and
 * throws, and nothing upstream depends on it.
 */
if (process.env.VITEST) {
  const home = os.homedir();
  const guarded = [
    {
      name: "KADY_PROJECTS_ROOT",
      raw: process.env.KADY_PROJECTS_ROOT,
      resolved: PROJECTS_ROOT,
      production: path.join(REPO_ROOT, "projects"),
    },
    {
      name: "PI_CODING_AGENT_DIR",
      raw: process.env.PI_CODING_AGENT_DIR,
      resolved: KADY_PI_AGENT_DIR,
      production: path.join(home, ".kady", "pi-agent"),
    },
    {
      name: "KADY_SKILLS_CACHE_DIR",
      raw: process.env.KADY_SKILLS_CACHE_DIR,
      resolved: KADY_SKILLS_CACHE_DIR,
      production: path.join(home, ".kady", "skills-cache"),
    },
  ];
  // Compare what the paths actually point at, not how they are spelled. A
  // symlink whose target is the production directory is that directory, and a
  // string comparison would wave it through; `/tmp` being a link to
  // `/private/tmp` on macOS is the everyday reminder that the two differ.
  // `realpathSync` throws on a path that does not exist yet — a temp root
  // about to be created, or `~/.kady/skills-cache` on a fresh machine — so
  // fall back to lexical resolution there, which is all a nonexistent path
  // can support.
  const canonical = (candidate: string): string => {
    try {
      return fs.realpathSync(candidate);
    } catch {
      return path.resolve(candidate);
    }
  };
  // A blank value is reported separately rather than resolved. `PROJECTS_ROOT`
  // treats `"   "` as a path, so it lands somewhere harmless-looking that is
  // neither the production directory nor a temp one, and saying it "resolves
  // to /…/server/   " would send the reader looking for a directory instead of
  // at their own environment.
  const unsafe = guarded
    .filter(({ raw, resolved, production }) =>
      raw !== undefined && !raw.trim() ? true : canonical(resolved) === canonical(production),
    )
    .map(({ name, raw, resolved }) =>
      raw !== undefined && !raw.trim() ? `${name} is blank` : `${name} resolves to ${resolved}`,
    );
  if (unsafe.length > 0) {
    throw new Error(
      `Refusing to run tests against the real user directories: ${unsafe.join("; ")}, ` +
        "which the suite deletes. server/vitest.config.ts points all three at the " +
        'OS temp dir — run tests with "npm test" from server/, or ' +
        '"npm run verify -- server" from the repository root, rather than invoking ' +
        "vitest somewhere that config is not loaded.",
    );
  }
}

export const DEFAULT_PROJECT_ID = "default";

/** HTTP port for the backend (matches the old ADK server). */
export const PORT = Number(process.env.KADY_PORT ?? process.env.PORT ?? 8000);
export const HOST = process.env.KADY_HOST ?? "127.0.0.1";

/**
 * Explicit opt-in for Kady's inbound MCP server. The existing `mcp` routes
 * configure outbound connectors; this gate is only for exposing Kady itself
 * as an MCP server on the shared Fastify listener.
 */
export const MCP_ENABLED = process.env.KADY_MCP_ENABLED === "1";

/**
 * The MCP server has no remote authentication story in Phase 2. Its shared
 * listener must therefore be a literal loopback address whenever enabled.
 * Do not accept `localhost`: its resolution is host-configurable, whereas
 * these literals are unambiguously local on every supported platform.
 */
export function assertMcpLoopbackHost(host = HOST, enabled = MCP_ENABLED): void {
  if (!enabled) return;
  const normalized = host.trim().toLowerCase();
  if (normalized === "127.0.0.1" || normalized === "::1") return;
  throw new Error(
    `KADY_MCP_ENABLED requires a loopback KADY_HOST; received ${JSON.stringify(host)}`,
  );
}

/** Default orchestrator model, routed through Pi's OpenRouter provider. */
export const DEFAULT_MODEL_PROVIDER =
  process.env.DEFAULT_MODEL_PROVIDER ?? "openrouter";
export const DEFAULT_MODEL_ID =
  process.env.DEFAULT_MODEL_ID ?? "openai/gpt-6-astra";

export const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

/**
 * Local OpenAI-compatible model server (LM Studio, vLLM, text-generation-webui,
 * …) discovered through the standard `/v1/models` endpoint. Defaults to LM
 * Studio's port so that case needs no configuration; vLLM's default (8000)
 * collides with this backend, so those users must move one of the two.
 */
export const OPENAI_COMPATIBLE_BASE_URL =
  process.env.OPENAI_COMPATIBLE_BASE_URL?.trim() || "http://localhost:1234";

/**
 * Whether the user explicitly pointed us at a server. The picker hides the
 * section entirely unless this is true or a server actually answers, so the
 * majority who have never run one never see a dead "not running" row.
 */
export const OPENAI_COMPATIBLE_CONFIGURED = Boolean(
  process.env.OPENAI_COMPATIBLE_BASE_URL?.trim(),
);

/** Whether Modal-style remote compute is configured (kept for /config parity). */
export function modalConfigured(): boolean {
  return Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);
}
