/**
 * System + misc endpoints: version/resource probes plus /ollama/models and
 * /openai-compatible/models (local model discovery). Skill management lives in
 * api/skills.ts; /health and /config live in index.ts.
 */
import type { FastifyInstance } from "fastify";
import {
  OLLAMA_BASE_URL,
  OPENAI_COMPATIBLE_BASE_URL,
  OPENAI_COMPATIBLE_CONFIGURED,
} from "../config.ts";
import {
  cacheKey,
  getContextWindow,
  probeArchitecturalOllama,
  probeLoaded,
  recordArchitectural,
} from "../agent/local-context.ts";
import { getSystemStats } from "../system-stats.ts";

const GITHUB_REPO = "kgforais1/k-dense-byok-mcp";
const VERSION_CACHE_TTL_MS = 60 * 60 * 1000; // re-check at most once per hour
let versionCache: { ts: number; latestVersion: string | null } | null = null;

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  // Server-side proxy for the "latest release" check. Doing the GitHub fetch
  // here (instead of the browser) keeps the unauthenticated-rate-limit 403 out
  // of the user's console, lets us cache across reloads, and can use a token if
  // one is configured. Always 200s with a (possibly null) version.
  app.get("/version/latest", async () => {
    const now = Date.now();
    if (versionCache && now - versionCache.ts < VERSION_CACHE_TTL_MS) {
      return { latestVersion: versionCache.latestVersion };
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const token = process.env.GITHUB_TOKEN;
      const resp = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        {
          signal: ctrl.signal,
          headers: {
            Accept: "application/vnd.github+json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );
      clearTimeout(t);
      if (!resp.ok) {
        versionCache = { ts: now, latestVersion: null };
        return { latestVersion: null };
      }
      const data = (await resp.json()) as { tag_name?: string };
      const latestVersion = (data.tag_name ?? "").replace(/^v/, "") || null;
      versionCache = { ts: now, latestVersion };
      return { latestVersion };
    } catch {
      versionCache = { ts: now, latestVersion: null };
      return { latestVersion: null };
    }
  });

  // Live host-resource snapshot for the header monitor. Global (not
  // project-scoped); polled by the UI every few seconds.
  app.get("/system/resources", async () => getSystemStats());

  // Proxy local Ollama tags → the UI Model shape. Returns available:false if
  // Ollama isn't running (the picker just hides the section).
  app.get("/ollama/models", async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const resp = await fetch(`${OLLAMA_BASE_URL.replace(/\/+$/, "")}/api/tags`, {
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!resp.ok) return { available: false, models: [] };
      // Deliberately `unknown`: the guards below are what make the shape
      // safe, and a cast here would only let the compiler agree with an
      // assumption the daemon has not made.
      const data: unknown = await resp.json();
      // Anything that is not a `{ models }` object is a malformed answer: we
      // learned nothing about what is installed. Report it the same way as an
      // unreachable daemon, because the alternative reads as `available: true`
      // with an empty list, and the picker renders that as "Ollama is running
      // but no models are pulled" — telling a user with a shelf full of models
      // to go pull one. Both levels have to be checked: a top-level array,
      // string or number would sail past a `models`-only test, since reading
      // `.models` off it is merely `undefined` rather than an error.
      //
      // An *absent* `models` key is the one benign case and stays an empty
      // list, since that is a daemon saying it has none.
      const payload =
        data !== null && typeof data === "object" && !Array.isArray(data)
          ? (data as {
              models?: ({
                name?: unknown;
                digest?: unknown;
                details?: { context_length?: unknown };
              } | null)[];
            })
          : undefined;
      if (!payload) return { available: false, models: [] };
      if (payload.models !== undefined && !Array.isArray(payload.models)) {
        return { available: false, models: [] };
      }
      // Individual rows are a different matter: losing context metadata is
      // acceptable, losing the list is not, so a nullish row or one with no
      // usable name is dropped and the rest of the list survives. Dropped
      // rather than rendered, because `ollama/undefined` is a selectable
      // entry that resolves to nothing.
      const rows = payload.models ?? [];
      // Every named row, with the digest that identifies this pull of it, for
      // the `/api/show` fallback below. Deciding *there* which of them still
      // owe a call keeps one rule in one place: this route would otherwise
      // have to reproduce the cache's positive-integer test to notice that a
      // `context_length` of `0` left the slot empty.
      const listed: { id: string; digest?: string }[] = [];
      const models = rows.flatMap((m) => {
        // Rejected, not trimmed: a whitespace-only name is as unusable as a
        // missing one, and trimming would invent an id the daemon never
        // reported, whose key could never match a /api/ps row.
        if (!m) return [];
        const name = m.name;
        if (typeof name !== "string" || !name.trim()) return [];
        // Architectural figure, parsed inline from the payload already in
        // hand — no extra call. Lenient like the rest of this route: a
        // missing or malformed value records nothing (absent, not zero).
        const architectural =
          typeof m.details?.context_length === "number"
            ? m.details.context_length
            : undefined;
        // The digest identifies this pull of the tag, and is recorded with
        // the figure so a later open can tell a current figure from one left
        // over from a different model of the same name.
        const digest = typeof m.digest === "string" ? m.digest : "";
        recordArchitectural(
          cacheKey("ollama", OLLAMA_BASE_URL, name),
          architectural,
          digest,
        );
        listed.push({ id: name, digest });
        return [
          {
            id: `ollama/${name}`,
            label: name,
            provider: "Ollama",
            tier: "budget",
            context_length:
              getContextWindow("ollama", OLLAMA_BASE_URL, name) ?? 0,
            pricing: { prompt: 0, completion: 0 },
            modality: "text->text",
            description: `Local Ollama model: ${name}`,
          },
        ];
      });
      // Loaded figures, unawaited with the probe's own timeout inside. It
      // never rejects, so no .catch() — and awaiting it would stall the
      // picker on a hung daemon behind a list it already has.
      void probeLoaded("ollama", OLLAMA_BASE_URL);
      // FORK: `details.context_length` is undocumented, so a row without it is
      // an Ollama-side change rather than a bug. Rows still missing a figure
      // get the documented `/api/show` read, unawaited for the same reason.
      // It makes no call at all on a daemon that still emits the field, which
      // is why the picker budget of two calls per open is unaffected in the
      // normal case.
      void probeArchitecturalOllama(OLLAMA_BASE_URL, listed);
      return { available: true, models };
    } catch {
      return { available: false, models: [] };
    }
  });

  // Same idea for any server speaking the standard OpenAI `/v1/models` shape
  // (LM Studio, vLLM, text-generation-webui, …). Kept as a parallel path to the
  // Ollama route above rather than factored into a shared helper: the two
  // discovery protocols are unrelated, and Ollama's is upstream-owned.
  //
  // `configured` tells the picker whether the user explicitly asked for this
  // provider, so it can stay hidden for everyone else instead of showing a
  // permanently dead section.
  app.get("/openai-compatible/models", async () => {
    const configured = OPENAI_COMPATIBLE_CONFIGURED;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const resp = await fetch(
        `${OPENAI_COMPATIBLE_BASE_URL.replace(/\/+$/, "")}/v1/models`,
        { signal: ctrl.signal },
      );
      clearTimeout(t);
      if (!resp.ok) return { available: false, configured, models: [] };
      const data: unknown = await resp.json();
      // Same two-level shape check as the Ollama route, for the same reason:
      // `{available: true, models: []}` renders as "The server is up but
      // serving no models. Load one and reopen this menu"
      // (`model-selector.tsx:405`), which is the wrong thing to tell someone
      // whose server is loaded and whose proxy answered with nonsense.
      // Converting "learned nothing" into "learned there are none" is the
      // failure; an absent `data` key is the one benign case, because that is
      // a server honestly reporting none.
      const payload =
        data !== null && typeof data === "object" && !Array.isArray(data)
          ? (data as { data?: unknown })
          : undefined;
      if (!payload) return { available: false, configured, models: [] };
      if (payload.data !== undefined && !Array.isArray(payload.data)) {
        return { available: false, configured, models: [] };
      }
      // Rows stay deliberately lenient: take `id` off each entry and skip
      // anything that doesn't have one, so a single odd row can't blank out
      // the whole list. Nothing beyond `id` is trusted — servers disagree on
      // every other field.
      const seen = new Set<string>();
      const models = [];
      for (const entry of payload.data ?? []) {
        const id = (entry as { id?: unknown })?.id;
        if (typeof id !== "string" || !id.trim() || seen.has(id)) continue;
        seen.add(id);
        models.push({
          id: `openai-compatible/${id}`,
          label: id,
          provider: "OpenAI-Compatible",
          tier: "budget",
          // Cached figure when the probe has landed, 0 on a cold cache —
          // which the picker renders as no badge, exactly as before. Never
          // awaited into correctness here: see below.
          context_length:
            getContextWindow("openai-compatible", OPENAI_COMPATIBLE_BASE_URL, id) ??
            0,
          pricing: { prompt: 0, completion: 0 },
          modality: "text->text",
          description: `Local OpenAI-compatible model: ${id}`,
        });
      }
      // Second, independent call for both context figures. Deliberately
      // unawaited with its own timeout inside the probe: awaiting would make
      // the picker wait the full 2 s for a hung probe before rendering a
      // list it already has, and sharing this route's AbortController would
      // abort the /v1/models call that had already succeeded. A 404 here
      // (vLLM and others have no such endpoint) means "no context metadata",
      // never "no models" — the rows above are already built.
      void probeLoaded("openai-compatible", OPENAI_COMPATIBLE_BASE_URL);
      return { available: true, configured, models };
    } catch {
      return { available: false, configured, models: [] };
    }
  });
}
