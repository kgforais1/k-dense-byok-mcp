/**
 * Process-wide configuration: directories, ports, and env-derived knobs.
 *
 * The TS backend replaces the Python FastAPI + ADK server. It keeps the same
 * on-disk `projects/` layout (so existing user data is preserved) but drops the
 * Gemini-CLI / LiteLLM / MCP machinery.
 */
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
 * skills cache and the installed-skills directories under `~/.kady`. That is
 * safe only because `server/vitest.config.ts` points all three at the OS temp
 * dir — and a vitest run that does not load that config gets the production
 * defaults instead. Running a test file from the repository root is enough to
 * miss it: there is no config there, so `vitest` uses its own defaults and the
 * env block never applies. The result is not a failing test. It is the user's
 * projects directory, sandboxes and venvs included, deleted in a `beforeEach`.
 *
 * That has already happened once here, on 2026-09-14: `projects/` was wiped
 * and left holding a project named `Observed` with a session directory called
 * `obs-1`, which are the fixture names in `test/session-observer.test.ts`.
 *
 * So `VITEST` — which vitest sets whether or not it found a config — turns the
 * three overrides into requirements. A test run that reaches this line without
 * them is one config away from destroying real data, and failing at import is
 * the only warning that arrives before the first `rmSync`.
 *
 * Marked because `config.ts` is upstream-owned and this is an in-place
 * insertion, so a future `git merge upstream/main` has a seam to resolve
 * against. The block is self-contained: it reads three environment variables
 * and throws, and nothing upstream depends on it.
 */
if (process.env.VITEST) {
  const missing = (
    [
      ["KADY_PROJECTS_ROOT", process.env.KADY_PROJECTS_ROOT],
      ["PI_CODING_AGENT_DIR", process.env.PI_CODING_AGENT_DIR],
      ["KADY_SKILLS_CACHE_DIR", process.env.KADY_SKILLS_CACHE_DIR],
    ] as const
  )
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Refusing to run tests against the real user directories: ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} unset, so this run would use ` +
        `${PROJECTS_ROOT} and ${KADY_PI_AGENT_DIR}, which the suite deletes. ` +
        'server/vitest.config.ts sets all three — run tests with "npm test" from ' +
        'server/, or "npm run verify -- server" from the repository root, rather ' +
        "than invoking vitest somewhere that config is not loaded.",
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
