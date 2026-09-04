# Architecture Map

A concise map of the packages, modules, and data flows in this fork.
Use it to find where a change belongs. The detail is in the code; this
doc only records the boundaries.

For agent-harness policy, see [`../../AGENTS.md`](../../AGENTS.md),
[`../../server/AGENTS.md`](../../server/AGENTS.md),
[`../../web/AGENTS.md`](../../web/AGENTS.md), and
[`../../.github/AGENTS.md`](../../.github/AGENTS.md). For product-facing
architecture prose, see [`../architecture.md`](../architecture.md); the
two are not duplicates — this one is for contributors picking a
destination, that one is for users reading about features.

## Two-service layout

The app runs two services, started together by the cross-platform
launcher `start.mjs` (wrapped by `./start.sh` on macOS/Linux and
`start.cmd` on Windows):

| Service | Port | Code | What it does |
|---|---|---|---|
| Frontend | 3000 | `web/` | Next.js 16 / React 19 UI, App Router, settings dialog, viewer registry. |
| Backend | 8000 | `server/` | Fastify HTTP/SSE server, Pi SDK lead agent, sandbox, cost ledger, provenance, durable Modal jobs, scientific helpers. |

The backend embeds the Pi coding-agent SDK
(`@earendil-works/pi-coding-agent`) and runs a single flat lead agent
with builtin tools, the `subagent`/`subagent_wait` delegation pair, an
`interview` clarifying-questions tool, the `pi-web-access` web tools,
live PDF annotation tools, a hybrid durable Modal tool family, and
per-project MCP tools from `.pi/mcp.json`. Specialist scientific
subagents are seeded into each project's `sandbox/.pi/agents/*.md` from
`server/src/agent/subagents.ts` (write-if-missing; user edits win).

## Backend package boundaries

```
server/
├── src/
│   ├── index.ts                  Fastify entry, route registration, undici proxy install
│   ├── env.ts                    layered .env loading (root, kady_agent/, server/)
│   ├── scope.ts                  AsyncLocalStorage project/session scope
│   ├── config.ts                 runtime config
│   ├── binaries.ts               cross-platform external-binary resolution (no `which`)
│   ├── http-proxy.ts             installs EnvHttpProxyAgent as global dispatcher
│   ├── prep.ts                   default project + skill seeding
│   ├── agent/                    lead-agent wiring:
│   │   ├── session-registry.ts     live Pi AgentSession objects + JSONL persistence
│   │   ├── models.ts               canonical provider/model refs, fusion pricing
│   │   ├── events.ts               AgentSessionEvent -> SSE schema mapping
│   │   ├── thinking.ts             per-run thinking level validation
│   │   ├── subagents.ts            seed subagent markdown
│   │   ├── subagent-bridge.ts      budget/cost ledger for child runs
│   │   ├── interview.ts            native `interview` tool (re-implements pi-interview)
│   │   ├── modal-tool.ts           hybrid Modal tool family registration
│   │   ├── notebook.ts             in-process `notebook` tool (lead only)
│   │   ├── model-refusal.ts        Anthropic refusal signal detection
│   │   ├── skills-fetch.ts         `skills` CLI fetcher
│   │   ├── skills-install.ts       preview->install + authoring + update checks
│   │   ├── skills-sync.ts          live skill-dir writer (sole)
│   │   ├── provider-auth.ts        Pi OAuth / API-key mediation
│   │   ├── prompt-images.ts        image-attachment validation
│   │   ├── run-ids.ts              runId mint/clear + run_start SSE frame
│   │   └── builtin-tool-overrides.ts
│   ├── api/                      route plugins (one per concern)
│   │   ├── sessions.ts            /sessions/:id/{run,history,interview,notebook,methods-draft}
│   │   ├── sandbox.ts             /sandbox/* (tree/read/write/move/upload/zip/raw/download,
│   │   │                          annotation sidecars, latex compile, synctex, sci-helpers)
│   │   ├── skills.ts              /skills* (project + global scope)
│   │   ├── models.ts              /models, /fusion presets
│   │   ├── model-providers.ts     /model-providers, /model-auth/flows
│   │   ├── modal.ts               /modal/* (durable jobs, instances)
│   │   ├── sci-helpers.ts         /sandbox/sci-summary, /sandbox/sci-render.png
│   │   ├── mcp.ts, mcp-toggle.ts  /mcp/* + enable/disable
│   │   └── credentials.ts         /credentials (API keys)
│   ├── cost/                     usage ledger + budget enforcement
│   ├── provenance/               observed step recorder, scanner, lookup, harvest
│   ├── modal/                    Modal job manager + CPU/GPU catalog
│   ├── latex/                    latexmk + SyncTeX wrappers
│   ├── helpers/                  Python helpers (anndata, chem, structure, massspec,
│   │                             arrays, imaging) + pyproject.toml + .venv
│   ├── project-archive.ts        project export/import
│   └── sandbox-fs.ts             sandbox-relative path canonicalization
├── pi-packages/                  vendored Pi packages given to child subagents:
│   ├── kady-notebook/            notebook tool for child pi processes only
│   ├── kady-modal/               Modal hybrid tools for child processes
│   └── kady-pdf-annotations/     PDF annotation tools for child processes
├── test/                         vitest, *.test.ts
├── package.json                  exact pins (Pi + extension packages)
├── tsconfig.json                 noEmit
└── vitest.config.ts              KADY_PROJECTS_ROOT -> tmp dir
```

### Boundary rules

- The lead agent is the only place the in-process `notebook` tool is
  registered; `kady-notebook` registers the same tool only in child `pi`
  processes (gated on `PI_SUBAGENT_CHILD`) so the two never collide.
- Vendored `kady-pdf-annotations` and `kady-modal` packages call the
  localhost project API so credentials and accounting stay centralized
  on the lead process.
- `server/src/cost/{billing,ledger}.ts` and
  `server/src/agent/subagent-bridge.ts` must stay in sync; a local run
  that misses all three defaults to `payg` and counts against the
  spend cap.
- Sandbox-relative paths are the only path style that crosses the
  API boundary (`apiRelative`/`toApiPath` in `sandbox-fs.ts`,
  `stripSandboxRoot` in `events.ts`). External binaries resolve via
  `binaries.ts`, never `which`.

## Frontend package boundaries

```
web/
├── src/
│   ├── app/                      Next.js App Router routes
│   ├── components/               UI components (chat, settings, file preview, viewers)
│   ├── components/viewers/       lazy-loaded viewers (one per file category)
│   ├── lib/                      client libs (sandbox hook, fusion presets, image attachments)
│   ├── lib/viewers/              viewer registry (registry.ts + registry.test.ts)
│   ├── data/models.json          synthesised OpenRouter catalogue
│   ├── types/                    shared types
│   └── pdfjs.d.ts                ambient types for PDF.js
├── next.config.ts                injects NEXT_PUBLIC_APP_VERSION from server/package.json
├── package.json                  no `version` field
└── vitest.config.ts
```

### Boundary rules

- Components are **view-only**; they decode and display, but never
  write back to the sandbox.
- New viewers must register in `web/src/lib/viewers/registry.ts` and
  match by `FileCategory` from `web/src/lib/use-sandbox.ts`; do not
  branch inside `FileViewer` to add a new format.
- Fusion pricing parity: the `JUDGE_CALLS_PER_TURN` multiplier and
  the judge accessor exist twice, in `server/src/agent/models.ts`
  and `web/src/lib/fusion-presets.ts`. `server/test/fusion-pricing.test.ts`
  enforces parity.
- The Capability hub (Model providers, Skills, Specialists, Connectors)
  lives inside Settings, not a separate Customize surface. Enable/disable
  is non-destructive (move to `*-disabled` counterparts). Live sessions
  keep their set.

## Project sandbox layout (runtime, per project)

```
projects/<projectId>/
├── project.json                  ProjectMeta
└── sandbox/                       Pi agent cwd; files visible to all tabs
    ├── user_data/                uploads
    ├── .pi/skills/               per-project skills (Pi-discovered)
    ├── .pi/skills-archived/      unchanged skills retired upstream
    ├── .pi/sessions/             Pi JSONL session files (one per tab)
    ├── .kady/skills-sync.json    manifest v2: origin, source/ref, catalogueDigest, removed
    ├── .kady/runs/<sessionId>/costs.jsonl       cost ledger
    ├── .kady/provenance/<sessionId>/steps.jsonl  observed step provenance
    └── .kady/modal/jobs/<jobId>/                durable Modal state, events, logs
```

This tree is the runtime agent's home; it is **not** the contributor
policy home. Contributor policy is in the scoped `AGENTS.md` files at
the repo root, `server/`, `web/`, and `.github/`. Changing seeded
runtime instructions (skills, agents, settings) under `sandbox/.pi/`
is a product behavior change and is reviewed separately.

## Data flows

### A. UI -> backend (chat run)

1. A chat tab posts to `POST /sessions/:id/run` (one tab = one Pi
   JSONL session). Each request carries `X-Project-Id` (or `?project`).
2. `index.ts` `onRequest` resolves the project id via
   `?project` -> `kady-project` cookie -> `default` and stores it in
   `AsyncLocalStorage` (`server/src/scope.ts`).
3. `server/src/api/sessions.ts` calls `session.prompt()` on the
   `AgentSession` from `server/src/agent/session-registry.ts` (max
   10 live sessions per project; each persisted as JSONL under
   `sandbox/.pi/sessions/`).
4. The SSE mapper in `server/src/agent/events.ts` translates
   `AgentSessionEvent` to the wire schema (`text_delta`,
   `thinking_delta`, `tool_start/update/end`, `turn_start/end`,
   `error`, terminal `cost`, `done`).
5. Inline image attachments ride the user message as Pi image blocks
   (validated by `server/src/agent/prompt-images.ts`: up to 12 images,
   5 MB each, png/jpeg/webp/gif; `web/src/lib/image-attachments.ts`
   downscales >3 MB client-side). `GET /sessions/:id/history` replays
   them for reopened tabs.

### B. Cost ledger + budgets

1. Before/after each run, `server/src/cost/ledger.ts` snapshots
   `getSessionStats()` and appends a row to
   `sandbox/.kady/runs/<sessionId>/costs.jsonl`
   (`role` = `agent` | `subagent` | `compute`).
2. `server/src/cost/billing.ts` classifies usage: OpenRouter/API-key and
   Anthropic OAuth usage are cap-counted; OpenAI Codex/Copilot/xAI
   subscription runs retain tokens plus `listPriceUsd` with
   `costUsd: 0`. NVIDIA NIM is classified `subscription` (Pi prices
   every NIM model at `$0`).
3. Durable Modal jobs reserve their strict worst-case estimated cost
   before admission (`server/src/modal/manager.ts`); project summaries
   expose spent/reserved/committed USD. Every terminal path reconciles
   the hold to estimated sandbox wall-time. A project
   `spendLimitUsd` blocks only cap-counted work when the new
   commitment would exceed the cap.

### C. Provenance (observed, not declared)

1. The run loop attaches a `ProvenanceRecorder`
   (`server/src/provenance/recorder.ts`) to the same
   `session.subscribe` stream the SSE mapper reads.
2. One observed step per tool call is appended to
   `sandbox/.kady/provenance/<sessionId>/steps.jsonl`.
3. Rows are **derived from observation, never model declaration**;
   there is no agent-facing tool that writes here, because provenance
   is what you check the model against.
4. `write`/`edit`/`read` name their file (edges `observed`); `bash`/
   `subagent`/unknown tools are opaque and get a bounded stat-only
   sandbox scan-diff (`server/src/provenance/scanner.ts`), whose edges
   downgrade to `inferred` when a neighbouring step finished before
   the scan ran.
5. Scans are async-drained so the event handler never blocks SSE for
   other tabs; `flush()` in the run's `finally` drains before the
   terminal frames.
6. Budgets (20k files, 512 MB/file hash, 200 edges/step) degrade
   visibly — `sandbox-too-large` / `scan-failed` / `unhashed` /
   `truncatedEdges` — since silent truncation reads as a verified
   absence of outputs.
7. Subagent work is harvested from each child's session JSONL on
   completion (`server/src/provenance/harvest.ts` + `bridge.ts`).
   Harvested refs are marked `identityAt: "harvest"`, `change` is
   `wrote`, and a child's opaque `bash` gets
   `degraded: "no-scan-baseline"` plus optional mtime-window
   `inferred` edges filtered by already-claimed paths.
8. UI: the **Provenance** button in the file preview header
   (`web/src/components/provenance-panel.tsx`); lookup is in
   `server/src/provenance/lookup.ts`.

### D. Skills

1. Two scopes: per-project `sandbox/.pi/skills/` and user-level
   `<agentDir>/skills/` (`~/.kady/pi-agent/skills` by default). Pi
   resolves project entries first; collisions are first-wins, so
   **a project skill shadows a global one**.
2. Every origin is fetched through the bundled `skills` CLI
   (`server/src/agent/skills-fetch.ts`), which downloads into a
   disposable staging cache (`KADY_SKILLS_CACHE_DIR`, default
   `~/.kady/skills-cache`) shaped as `.pi/skills/<name>/` because
   `-a pi --copy` targets exactly our layout.
3. The CLI is a **fetcher only**; its stdout is never parsed
   (truth = the staged tree + `skills-lock.json`).
4. `skills-sync.ts` remains the sole writer of live skill dirs, so
   tree hashing, the default-disabled policy, atomic per-skill
   replacement, local-edit preservation, and archive-on-removal
   all survive unchanged.
5. The catalogue (`KADY_SKILLS_REPO`, default
   `K-Dense-AI/scientific-agent-skills`) syncs at launch and daily
   (`KADY_SKILLS_SYNC_INTERVAL_MS`, min 60 s) and is project-scoped
   only. Fallback to a shallow `git clone` if the CLI fails, since
   it is on the first-run path.
6. Manifest v2 (`.kady/skills-sync.json`, migrated from v1 rather
   than discarded) adds a per-skill `origin` (`catalogue` /
   `registry` / `local`) plus recorded source/ref, a content
   `catalogueDigest` replacing the commit id, and `removed`
   tombstones.
7. `skills-install.ts` owns preview->install (the confirmed preview
   returns a `stagingToken` so the user installs the bytes they
   reviewed), authoring from a template with Pi's stricter name
   rule, in-place `SKILL.md` editing, origin-aware removal, and
   on-demand update checks. **User-installed skills are never
   auto-updated.** Live sessions keep their already-loaded skill
   set.

### E. Subagent delegation

1. The lead calls the `subagent` tool (from the **pi-subagents**
   package), which takes one `workflowScript` JavaScript string
   declaring children as `runs.run(key, { agent, task })`. Top-level
   `agent` now only addresses management actions; top-level `model`
   is a per-run override forwarded to every child.
2. `workflowScriptTargets()` reads the `agent:` / `model:` literals
   out of the script (the surface is opaque to structural walks).
   `pinWorkflowScriptModel` refuses to pin when names are computed
   because per-run `model` outranks agent frontmatter,
   `agentOverrides.<name>.model`, and `subagents.defaultModel`
   (all checked first in `settingsPinnedModels`).
3. Launches default to **async**, so the lead's tool allowlist in
   `session-registry.ts` must carry `subagent_wait` alongside
   `subagent` or Pi filters out the only way to block on the
   children it started.
4. Budget gating and cost ledgering for child runs live in
   `server/src/agent/subagent-bridge.ts`.
5. Notebook entries from children are harvested on completion
   (`server/src/agent/notebook-harvest.ts`), role-stamped with the
   agent name, and appended to the parent notebook (the parent is
   the single writer). Child entries appear batch-on-completion,
   not live. Nested subagents (depth > 1) are not harvested in
   this version.

### F. Interview (clarifying questions)

1. The `interview` custom tool (`server/src/agent/interview.ts`)
   blocks the run on a pending-answer promise.
2. Questions ride the normal `tool_start` SSE frame; the chat UI
   renders them as an inline form (`web/src/components/interview-form.tsx`),
   POSTing answers to `/sessions/:id/interview/:toolCallId`.
3. The tool is deliberately **not** exposed to sub-agent child
   processes — they are headless and must not block on user input.

### G. Modal (durable remote compute)

1. The lead always registers the hybrid tools in
   `server/src/agent/modal-tool.ts`; submission reports
   `NOT_CONFIGURED` until a token pair is validated in Settings.
2. `server/src/modal/manager.ts` owns persistent jobs under
   `.kady/modal/`, strict budget reservations, abort-safe sandbox
   creation, bounded logs, fallback resources, recursive/checksummed
   staging, atomic output installation, retry, batches, and
   restart recovery through saved sandbox ids.
3. `server/src/modal/catalog.ts` is the sole CPU/GPU and
   estimated-price catalogue (including multi-GPU strings through
   B200); the UI reads it from `/modal/instances`.
4. A project Modal Volume is cache-only and optional named
   environments publish reusable images; the local sandbox
   remains canonical.
5. Child `pi` processes receive the same tools from
   `server/pi-packages/kady-modal`, which calls the localhost
   project API so credentials and accounting stay centralized.
6. Costs are estimates, not Modal invoice reconciliation.

### H. Scientific previews

1. `server/src/api/sandbox.ts` ports file ops and rich previews;
   `server/src/api/sci-helpers.ts` (`sciHelperFor` / `runSciHelper`)
   routes a `kind` param to a helper's `summarize` / `render`
   subcommands over `GET /sandbox/sci-summary?path=&kind=` (JSON)
   and `GET /sandbox/sci-render.png?path=&kind=&index=&axis=`
   (image).
2. All helpers share the exit-code contract
   `0` ok / `3` deps-missing / `4` not-found / `5` bad-value /
   `1` other, mapped to HTTP by the routes.
3. Frontend viewer registry: `web/src/lib/viewers/registry.ts` maps
   a `FileCategory` (`web/src/lib/use-sandbox.ts`) to a lazy-loaded
   viewer in `web/src/components/viewers/*`; `FileViewer` in
   `file-preview-panel.tsx` checks the registry first and falls
   back to its built-in chain for the original categories
   (image/pdf/markdown/csv/notebook/fasta/biotable/latex/text).
4. New scientific viewers are **view-only**; user-facing coverage
   is in `docs/file-previews.md`; phased design/plans live under
   `docs/superpowers/`.

## How to add a new entry point

1. Pick the smallest category in
   [`README.md`](README.md#category-definitions) that fits.
2. Add the file or route to the matching tree above; if the entry
   crosses the API boundary, prefer extending an existing route
   plugin over creating a parallel one.
3. Update the manifest in the same PR (`scripts/repo-manifest.json`;
   `docs:check` validates target existence and category coverage).
4. Update the matching scoped `AGENTS.md` if the change introduces a
   new convention, dependency, or boundary rule.
