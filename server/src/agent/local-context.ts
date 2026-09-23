/**
 * Canonical-key cache for local-model context windows, plus the probes that
 * fill it. Phase 2 of `dev-docs/plans/2026-09-10-local-model-context-window.md`.
 *
 * The discovery routes (`GET /ollama/models`, `GET /openai-compatible/models`)
 * write into this cache; the model builders (`buildOllamaModel`,
 * `buildOpenAICompatibleModel`) read it back synchronously. Nothing on the run
 * path probes — see the plan's "Probe from the discovery routes" decision.
 *
 * KEY FORM — SERVER ROOT, not the model endpoint. The builders register the
 * model `baseUrl` as `<root>/v1`, but every probe endpoint lives on the root
 * (`/api/tags`, `/api/ps`, `/api/v0/models`). The cache key therefore uses the
 * root form, and `normalizeBaseUrl` strips a trailing `/v1` (after trailing
 * slashes) so that a caller holding either form lands on the same key. Both
 * the routes and the builders pass their root constants (`OLLAMA_BASE_URL`,
 * `OPENAI_COMPATIBLE_BASE_URL`); the `/v1` strip is belt-and-braces so a
 * future caller holding the model's `baseUrl` field still hits the entry the
 * route wrote instead of silently falling back.
 *
 * That strip assumes the configured base URL is the server root, which is
 * this repo's existing convention — the discovery routes and the builders all
 * append `/v1` themselves — so a trailing `/v1` can only be the model
 * endpoint. A base URL that genuinely ends in `/v1` is already broken for the
 * `/v1/models` route today, so nothing here regresses it.
 *
 * Entries never expire — they live until overwritten. Expiry would turn a
 * stale-but-loud value into the fallback, which is exactly the silent
 * under-declaration this module exists to remove (see the plan's "Do not
 * expire entries" decision).
 */
const PROBE_TIMEOUT_MS = 2000;

interface ContextEntry {
  architectural?: number;
  loaded?: number;
}

const cache = new Map<string, ContextEntry>();
const pending = new Map<string, Promise<void>>();
/** Cache keys with an `/api/show` call outstanding. Unlike `pending`, callers
 * never join one: the fallback's product is the cache write, and the next
 * picker open re-reads the cache anyway. */
const showInFlight = new Set<string>();

/**
 * Cache key → the `/api/tags` digest the architectural figure we currently
 * hold was obtained at (`""` where the row carried none). Written by whichever
 * path wrote the figure, which is what makes it a description of the figure
 * rather than of one probe.
 *
 * This is how a stale figure is noticed without a TTL. Re-pulling a tag under
 * the same name changes its digest, and that is the exact signal that the
 * number we hold describes a different model. It costs nothing when nothing
 * has moved.
 *
 * It has to cover the tags path too, not just `/api/show`. `recordArchitectural`
 * no-ops on a missing value, so a row that carried `details.context_length`
 * on one open and not the next — an Ollama upgrade that dropped the
 * undocumented field, which is the whole premise of the fallback — keeps its
 * old figure rather than losing it. If only `/api/show` answers were dated,
 * that surviving figure would look current forever, and a smaller replacement
 * model would run over-declared.
 */
const architecturalDigests = new Map<string, string>();

/** Fan-out ceiling for the `/api/show` fallback, shared across calls rather
 * than per call. It runs once per model, so a daemon that stopped emitting
 * `details.context_length` for every row would otherwise open one socket per
 * installed model at once — and two overlapping picker opens whose missing
 * rows did not overlap would each have got their own pool. */
const SHOW_CONCURRENCY = 4;

interface ShowJob {
  key: string;
  root: string;
  modelId: string;
  digest: string;
  done: () => void;
}

/** One queue and one worker count for the whole process, which is what makes
 * `SHOW_CONCURRENCY` a daemon-wide ceiling instead of a per-call one. */
const showQueue: ShowJob[] = [];
let showWorkers = 0;

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Root form: trailing slashes stripped (as the builders/routes already do),
 * then one trailing `/v1` segment so the model endpoint and the server root
 * share a key. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Ollama-only `:latest` normalisation. "No tag" is decided on the segment
 * after the last `/`, not on the whole string: an id may be
 * registry-qualified (`hf.co/user/model:Q4_K_M`, already tagged) or carry a
 * registry port (`localhost:5000/foo`, untagged despite the colon).
 * OpenAI-compatible ids are never normalised — LM Studio ids routinely carry
 * no colon at all, so the same rule would tag every id and break every key.
 */
function normalizeModelId(providerId: string, modelId: string): string {
  if (providerId !== "ollama") return modelId;
  const tail = modelId.slice(modelId.lastIndexOf("/") + 1);
  return tail.includes(":") ? modelId : `${modelId}:latest`;
}

/** Canonical cache key: `(providerId, normalizedBaseUrl, bareModelId)`. The
 * model id is the bare id the builders see (the `ollama/` /
 * `openai-compatible/` ref prefix is stripped by `resolveModel` before the
 * builders run), so a ref-keyed entry would miss on every read. */
export function cacheKey(
  providerId: string,
  baseUrl: string,
  modelId: string,
): string {
  return `${providerId}\n${normalizeBaseUrl(baseUrl)}\n${normalizeModelId(providerId, modelId)}`;
}

/** `loaded ?? architectural`, recomputed on every read. The two figures are
 * stored in separate slots and merged here — never a merged stored number —
 * because the loaded figure is the transient of the pair.
 *
 * Deliberately digest-blind. Between a re-pull that `/api/tags` cannot
 * describe and the `/api/show` answer that corrects it, this returns the
 * previous pull's figure. Refusing it instead would return `undefined`, and
 * `resolveModel` reads that as the 128,000 floor — which for the models this
 * path serves is usually the *larger* number, so the stricter read would
 * widen the over-declaration it was meant to close. A stale figure that
 * `needsShow` is already queueing a correction for beats a floor that nothing
 * will correct. */
export function getContextWindow(
  providerId: string,
  baseUrl: string,
  modelId: string,
): number | undefined {
  const entry = cache.get(cacheKey(providerId, baseUrl, modelId));
  return entry?.loaded ?? entry?.architectural;
}

/** Writes only a positive integer; anything else (including `undefined`) is a
 * no-op that leaves an existing entry alone. A failed refresh is therefore a
 * no-op, never a downgrade.
 *
 * `digest` dates the figure — Ollama callers pass the `/api/tags` digest of
 * the pull it describes, so `needsShow` can tell a current figure from one
 * left over from a different model of the same name. Omitting it leaves any
 * existing date alone, which is what the OpenAI-compatible path wants: it has
 * no equivalent and never consults the map. A rejected value dates nothing,
 * because the figure it would have dated was not written. */
export function recordArchitectural(
  key: string,
  value: number | undefined,
  digest?: string,
): void {
  if (!isPositiveInt(value)) return;
  let entry = cache.get(key);
  if (!entry) {
    entry = {};
    cache.set(key, entry);
  }
  entry.architectural = value;
  if (digest !== undefined) architecturalDigests.set(key, digest);
}

/**
 * Same positive-integer rule as `recordArchitectural`, except `undefined`
 * clears the loaded slot instead of no-op'ing. That is how an unloaded model
 * reverts to its architectural figure.
 */
export function recordLoaded(key: string, value: number | undefined): void {
  if (value === undefined) {
    const entry = cache.get(key);
    if (entry) delete entry.loaded;
    return;
  }
  if (!isPositiveInt(value)) return;
  let entry = cache.get(key);
  if (!entry) {
    entry = {};
    cache.set(key, entry);
  }
  entry.loaded = value;
}

/**
 * Best-effort probe of the loaded context figures for one server. Never
 * rejects: a timeout, dead daemon, 404 or malformed body resolves normally
 * with no cache write. Its product is the cache write, not a return value.
 *
 * Concurrent callers for the same `(providerId, baseUrl)` join the in-flight
 * promise instead of starting a rival — which also closes the write-
 * reordering window. The pending entry is cleared on settle (success or
 * failure) so one failed probe cannot block every later retry.
 */
export function probeLoaded(providerId: string, baseUrl: string): Promise<void> {
  const root = normalizeBaseUrl(baseUrl);
  const dedupKey = `${providerId}\n${root}`;
  const inFlight = pending.get(dedupKey);
  if (inFlight) return inFlight;
  const task = runProbe(providerId, root).finally(() => {
    if (pending.get(dedupKey) === task) pending.delete(dedupKey);
  });
  pending.set(dedupKey, task);
  return task;
}

/** `runProbe` cannot reject (every fetch is failure-contained in `getJson`),
 * but the `try/catch` stays as a second layer so the `Promise<void>`
 * never-rejects contract does not depend on auditing every line below. */
async function runProbe(providerId: string, root: string): Promise<void> {
  try {
    if (providerId === "ollama") {
      await probeOllama(root);
    } else if (providerId === "openai-compatible") {
      await probeOpenAICompatible(root);
    }
  } catch {
    // Never rejects — a failed probe is a no-op, not an error.
  }
}

/** One fetch with its own `AbortController` and timeout, matching the
 * discovery routes. Returns `undefined` on any failure (network error,
 * abort, non-2xx, malformed body); callers treat that as "leave the cache
 * alone". */
async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    if (!resp.ok) return undefined;
    return (await resp.json()) as unknown;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function arrayField(body: unknown, field: string): unknown[] | undefined {
  if (body !== null && typeof body === "object") {
    const value = (body as Record<string, unknown>)[field];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Clears the loaded slot of every cached model on this server that `reported`
 * does not contain. Called only after a *successful* loaded-probe: absence
 * from a good answer is what unloading looks like, while a failed probe
 * clears nothing (every transient blip would otherwise wipe a good figure).
 *
 * `complete` says whether every row in the answer named a model we could key
 * on. Clearing is an argument from absence, so it is only sound over a
 * complete snapshot: a row we could not identify might have been the one
 * loaded model whose figure we are about to drop, and dropping it reverts to
 * the *higher* architectural number, which over-declares — the exact failure
 * this module exists to prevent. One unreadable row therefore forfeits the
 * clear for the whole answer, not just for itself. An answer with genuinely
 * zero rows is complete and does clear, because that is what "nothing is
 * loaded" looks like on `/api/ps`.
 */
function clearUnreportedLoaded(
  providerId: string,
  root: string,
  reported: Set<string>,
  complete: boolean,
): void {
  if (!complete) return;
  const prefix = `${providerId}\n${root}\n`;
  for (const [key, entry] of cache) {
    if (key.startsWith(prefix) && !reported.has(key) && entry.loaded !== undefined) {
      delete entry.loaded;
    }
  }
}

/**
 * Fallback source for Ollama's architectural figure. Takes the whole
 * `/api/tags` list and decides per row, in `needsShow`, whether a call is
 * owed — the caller does not filter.
 *
 * `details.context_length` is undocumented — Ollama documents only `format`,
 * `family`, `families`, `parameter_size` and `quantization_level` — so it can
 * disappear in an upgrade without that being a regression on Ollama's side.
 * `/api/show` is documented and reports the same figure, but costs one POST
 * per model against a picker-open budget of two calls total. So it is the
 * fallback and not the source: on a daemon that still emits the tags field
 * this never fires, and it pays only in the failure it exists for. Decided
 * 2026-09-20; the field survey behind it is
 * `dev-docs/plans/completed/2026-09-10-local-model-context-window-findings.md`.
 *
 * Never rejects, like the loaded probe, and its product is the cache write.
 * The write lands after the response the picker is already rendering, so the
 * figure appears on the *next* open — the same second-open shape LM Studio
 * rows have always had.
 */
export function probeArchitecturalOllama(
  baseUrl: string,
  models: { id: string; digest?: string; tagged?: number }[],
): Promise<void> {
  const root = normalizeBaseUrl(baseUrl);
  const queued: Omit<ShowJob, "done">[] = [];
  for (const model of models) {
    const key = cacheKey("ollama", root, model.id);
    const digest = model.digest ?? "";
    // Every row is offered, and the decision to call is made here against the
    // cache rather than by the caller against the payload. A caller judging
    // "this row had no figure" has to reproduce `recordArchitectural`'s
    // positive-integer rule to get it right, and a `details.context_length`
    // of `0` or `-1` is present-but-rejected: the slot stays empty while the
    // row looks answered, and the model silently takes the 128,000 floor.
    if (!needsShow(key, digest, model.tagged)) continue;
    // Reserved synchronously, before any await, so two overlapping opens
    // cannot both queue the same model. Doubles as the within-batch
    // duplicate check.
    if (showInFlight.has(key)) continue;
    showInFlight.add(key);
    queued.push({ key, root, modelId: model.id, digest });
  }
  if (queued.length === 0) return Promise.resolve();
  // The executor runs synchronously, so the jobs are still enqueued and the
  // pool still topped up before this function returns — which is what lets
  // the reservations above stand against a concurrent caller.
  return new Promise<void>((resolve) => {
    let outstanding = queued.length;
    const done = (): void => {
      outstanding -= 1;
      if (outstanding === 0) resolve();
    };
    for (const job of queued) showQueue.push({ ...job, done });
    pumpShowQueue();
  });
}

/**
 * Two reasons to call, and no others. Either we hold no figure for the model
 * — including the case where one arrived and was rejected as unusable — or we
 * hold one dated to a different pull, meaning the tag was re-pulled under the
 * same name and may now be a smaller model.
 *
 * The date is what makes the second case sound, and it is why the tags path
 * dates its writes too. `/api/tags` answering this open is not something this
 * function can observe: `recordArchitectural` no-ops on a missing value, so a
 * figure that survived an open where the row carried none is indistinguishable
 * from one just written. The date distinguishes them, because the route
 * records it in the same call as the figure.
 *
 * Note what this deliberately does not do: give up. A model `/api/show`
 * cannot answer for is asked again on the next open, so the cost of a
 * permanently unanswerable model is one call per picker open. Remembering the
 * failure instead would make a transient one permanent, and the figure it
 * denies us is the difference between the real window and a 128,000 floor
 * that over-declares it.
 */
function needsShow(key: string, digest: string, tagged: number | undefined): boolean {
  // `/api/tags` answered for this row on this open, so whatever is in the
  // cache is this pull's figure and nothing is owed — whatever we held
  // before. Judged here, against the same `isPositiveInt` rule that decides
  // whether the value was written at all, rather than by the caller.
  if (isPositiveInt(tagged)) return false;
  if (cache.get(key)?.architectural === undefined) return true;
  // Past this point the figure survived an open rather than being written by
  // it, so it is current only if it is dated to this pull. A row carrying no
  // digest cannot be dated, and two undated pulls of the same name compare
  // equal — so an undated row is asked about every open rather than trusted.
  // That costs one call per open for a daemon that reports neither field,
  // which is the same daemon already paying for the fallback; the alternative
  // is holding a number that may describe a model someone has since replaced.
  if (digest === "") return true;
  return architecturalDigests.get(key) !== digest;
}

/** Tops the shared worker pool back up to `SHOW_CONCURRENCY`. Safe to call
 * whenever the queue or the worker count changes; a no-op when the pool is
 * already full or the queue is empty. */
function pumpShowQueue(): void {
  while (showWorkers < SHOW_CONCURRENCY && showQueue.length > 0) {
    showWorkers += 1;
    void runShowWorker();
  }
}

/** Drains the shared queue until it is empty, then retires. One of at most
 * `SHOW_CONCURRENCY` of these; `pumpShowQueue` is the only thing that starts
 * one. */
async function runShowWorker(): Promise<void> {
  try {
    for (;;) {
      const job = showQueue.shift();
      if (!job) return;
      try {
        await showOne(job);
      } catch {
        // Never rejects — one failed model is a no-op, not an error, and
        // must not abandon the rest of the queue.
      } finally {
        showInFlight.delete(job.key);
        job.done();
      }
    }
  } finally {
    showWorkers -= 1;
    // Unreachable today, and deliberately kept. The window it would close —
    // a worker seeing an empty queue while a caller enqueues against a pool
    // that still looks full — cannot open, because there is no await between
    // the empty `shift()` and this line, and `probeArchitecturalOllama`
    // enqueues and pumps synchronously. Both halves of that are easy to lose
    // to a later edit, and the cost of the call is a comparison.
    pumpShowQueue();
  }
}

/** One model's `/api/show` read. Dates the figure it writes with the digest
 * the job was queued at, so a later open can tell it from a figure left over
 * from a different pull of the same name. */
async function showOne(job: ShowJob): Promise<void> {
  const body = await getJson(`${job.root}/api/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: job.modelId }),
  });
  recordArchitectural(job.key, architecturalFromShow(body), job.digest);
}

/**
 * `/api/show` reports the window under an architecture-prefixed key —
 * `llama.context_length`, `qwen3.context_length` — so its name is only
 * knowable from `general.architecture` in the same object.
 *
 * Where the architecture is *absent*, a single key ending in
 * `.context_length` is taken instead, because one candidate is not a guess.
 * Several are, and a wrong pick here over-declares the window, which is the
 * failure this module exists to prevent — so ambiguity records nothing and
 * the row keeps whatever it had.
 *
 * Where the architecture is present but its key is missing or unusable, the
 * answer is nothing, not the lone-key fallback. A body that names one
 * architecture and carries a window for another is a body we do not
 * understand; the lone key there is evidence against the reading, not for it.
 */
function architecturalFromShow(body: unknown): number | undefined {
  const info = asRecord(asRecord(body)?.["model_info"]);
  if (!info) return undefined;
  const architecture = info["general.architecture"];
  if (typeof architecture === "string" && architecture) {
    return asNumber(info[`${architecture}.context_length`]);
  }
  const candidates = Object.entries(info).filter(([name]) =>
    name.endsWith(".context_length"),
  );
  return candidates.length === 1 ? asNumber(candidates[0][1]) : undefined;
}

async function probeOllama(root: string): Promise<void> {
  // `/api/ps` only. The architectural figure comes from `/api/tags`, which the
  // discovery route has already fetched to build its response, so it records
  // that inline with `recordArchitectural` rather than paying for a second
  // fetch here. That keeps a picker open at the budgeted two calls — the
  // route's `/api/tags` plus this one — and is why an Ollama row carries a
  // badge on the *first* open while LM Studio's carries none until the
  // second. The badge is the architectural maximum until this probe lands,
  // so a model loaded smaller than its maximum reads high until then.
  //
  // `/api/ps` returns every running model at once, so one call covers all of
  // them. It lists running models only, so a cached model missing from a good
  // answer has unloaded.
  const ps = await getJson(`${root}/api/ps`);
  const psModels = arrayField(ps, "models");
  if (!psModels) return;
  const reported = new Set<string>();
  let complete = true;
  for (const model of psModels) {
    const row = asRecord(model);
    // Same predicate as the discovery route: a whitespace-only name is
    // unusable, and the two must agree. If this side accepted one, the row
    // would join `reported` under a key nothing else ever writes, the
    // snapshot would look complete, and every genuinely loaded model absent
    // from it would have its figure cleared — reverting to the higher
    // architectural number and over-declaring.
    const name = row?.["name"];
    if (typeof name !== "string" || !name.trim()) {
      complete = false;
      continue;
    }
    const key = cacheKey("ollama", root, name);
    reported.add(key);
    // Unlike LM Studio's endpoint, `/api/ps` lists *only* running models, so
    // a row being here already means loaded. Absence of `context_length` is
    // therefore missing metadata about a loaded model, not evidence that it
    // unloaded, and it is handled the same as an unreadable value: keep what
    // we had. Clearing on either would revert to the higher architectural
    // figure and over-declare. This is why the two probes treat a missing
    // field oppositely — the two endpoints mean different things by absence.
    const contextLength = asNumber(row?.["context_length"]);
    if (contextLength !== undefined) recordLoaded(key, contextLength);
  }
  clearUnreportedLoaded("ollama", root, reported, complete);
}

async function probeOpenAICompatible(root: string): Promise<void> {
  // LM Studio's own endpoint carries both figures per model. Every listed
  // entry gets its architectural figure recorded regardless of load state —
  // never skip an entry because it is not loaded. A listed entry without a
  // loaded figure is not loaded, so its loaded slot is cleared (revert to
  // architectural); entries missing from a good answer are cleared the same
  // way. `loaded_context_length` wins wherever present: it is what the next
  // request is measured against, and it can be lower.
  const body = await getJson(`${root}/api/v0/models`);
  const rows =
    arrayField(body, "data") ?? (Array.isArray(body) ? body : undefined);
  if (!rows) return;
  const reported = new Set<string>();
  let complete = true;
  for (const row of rows) {
    const entry = asRecord(row);
    const id = entry?.["id"];
    if (!entry || typeof id !== "string" || !id.trim()) {
      complete = false;
      continue;
    }
    const key = cacheKey("openai-compatible", root, id);
    // First occurrence wins, as it does in the discovery route, which skips
    // an id it has already seen (`system.ts:181`). A server repeating an id
    // with different figures is malformed either way, but the row the user
    // picked from the list and the figure cached against it must come from
    // the same one.
    if (reported.has(key)) continue;
    reported.add(key);
    recordArchitectural(key, asNumber(entry?.["max_context_length"]));
    // Absent and unreadable are different answers. No `loaded_context_length`
    // means the model is listed but not loaded, so the slot is cleared. A
    // field that is present but not a usable number tells us nothing, and
    // treating it as absent would clear a good figure in favour of the higher
    // architectural one.
    const rawLoaded = entry["loaded_context_length"];
    if (rawLoaded === undefined || rawLoaded === null) {
      recordLoaded(key, undefined);
    } else if (isPositiveInt(rawLoaded)) {
      recordLoaded(key, rawLoaded);
    }
  }
  clearUnreportedLoaded("openai-compatible", root, reported, complete);
}
