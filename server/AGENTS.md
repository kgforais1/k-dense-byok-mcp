# Backend Guidance (`server/`)

Scoped to the TypeScript backend. Read the root
[`../AGENTS.md`](../AGENTS.md) first for cross-agent policy, fork/hook
constraints, and the source-of-truth order; this file owns only backend deltas.

## What lives here

- Fastify HTTP server (port 8000) with SSE streaming for chat runs.
- Pi coding-agent SDK integration: a single flat lead agent with builtin tools,
  the `subagent`/`subagent_wait` delegation pair, `interview`, `web_search`/
  `fetch_content`/`get_search_content`, `add_pdf_annotation`/
  `list_pdf_annotations`/`remove_pdf_annotation`, the hybrid Modal tool family
  (`modal_run`/`modal_submit`/`modal_status`/`modal_wait`/`modal_cancel`/
  `modal_results`/`modal_submit_batch`), the in-process `notebook` tool, and
  per-project MCP tools loaded from `.pi/mcp.json`.
- Standalone Python scientific helpers under `src/helpers/` running in a
  dedicated uv-managed venv.
- Vitest suite under `test/`.

## Layout

```
server/
├── src/
│   ├── index.ts               # Fastify entry, route registration, undici proxy
│   ├── env.ts                 # layered .env loading (root, kady_agent/, server/)
│   ├── scope.ts               # AsyncLocalStorage project/session scope
│   ├── config.ts              # runtime config
│   ├── binaries.ts            # cross-platform external-binary resolution
│   ├── http-proxy.ts          # installs EnvHttpProxyAgent as global dispatcher
│   ├── prep.ts                # default project + skill seeding
│   ├── agent/                 # lead-agent wiring (session registry, models, tools, events)
│   ├── api/                   # route plugins (sandbox, sessions, skills, models, modal, ...)
│   ├── cost/                  # usage ledger + budget enforcement
│   ├── provenance/            # observed step recorder + scanner
│   ├── modal/                 # durable Modal job manager + catalog
│   ├── latex/                 # latexmk + SyncTeX wrappers
│   ├── helpers/               # Python helpers + pyproject.toml + .venv
│   ├── project-archive.ts     # project export/import
│   └── sandbox-fs.ts          # sandbox-relative path canonicalization
├── pi-packages/               # vendored Pi packages given to child subagents
│                             # (kady-notebook, kady-modal, kady-pdf-annotations)
├── test/                      # vitest, *.test.ts and *.test.tsx
├── pyproject.toml             # helper venv definition
├── package.json               # exact pins for Pi + extension packages
├── tsconfig.json              # noEmit (typecheck only)
└── vitest.config.ts           # KADY_PROJECTS_ROOT -> tmp dir
```

## Commands

Run from `server/`:

```bash
npm install                 # install deps (Pins: see "Harness pinning" below)
npm run dev                 # tsx watch on port 8000
npm run start               # run backend (tsx)
npm run prep                # ensure default project + seed scientific skills
npm run typecheck           # tsc --noEmit
npm test                    # vitest
```

The cross-platform launcher `start.mjs` (wrapped by `./start.sh` on
macOS/Linux and `start.cmd` on Windows) installs deps, seeds skills, then
starts backend + frontend together; it is the only supported full-app path.

## Fastify conventions

- Route plugins live under `src/api/`; one plugin per concern (`sandbox.ts`,
  `sessions.ts`, `skills.ts`, `models.ts`, `model-providers.ts`, `modal.ts`,
  etc.). Register them in `index.ts` and keep registration order stable.
- The `onRequest` hook in `index.ts` is the canonical place to populate
  `AsyncLocalStorage` scope from `?project` → `kady-project` cookie → `default`;
  per-request scope helpers live in `src/scope.ts`.
- Sandbox-relative paths are canonicalized to forward slashes at the API
  boundary (`apiRelative`/`toApiPath` in `src/sandbox-fs.ts`,
  `stripSandboxRoot` in `src/agent/events.ts`). The frontend always sees
  `/`-separated paths.
- External binaries are located via `src/binaries.ts` (`hasBinary`/`findUv`/
  `firstRunnable`), never `which`.

## Pi SDK integration

- The harness is pinned to exact versions (no caret) in `package.json`:
  `@earendil-works/pi-{agent-core,ai,coding-agent}` (shared version line) and
  the extension packages `pi-subagents`, `pi-web-access`, and `skills`. Pi's
  three packages must stay on one version. `start.mjs` reads those pins and
  installs them as explicit `name@version` specs on every full start.
- The lead agent is a single flat agent; delegation happens through
  `subagent`/`subagent_wait`. Specialist scientific agents are seeded into
  each project's `sandbox/.pi/agents/*.md` from `src/agent/subagents.ts`
  (write-if-missing; user edits win). Budget gating and cost ledgering for
  child runs live in `src/agent/subagent-bridge.ts`.
- `workflowScript` is the only delegation surface since pi-subagents 0.43.
  `workflowScriptTargets()` reads the `agent:`/`model:` literals out of the
  script; `pinWorkflowScriptModel` refuses to pin when names are computed
  because per-run `model` outranks agent frontmatter, `agentOverrides`, and
  `subagents.defaultModel` (all checked first in `settingsPinnedModels`).
- Builtin tool overrides are reconciled in `src/agent/builtin-tool-overrides.ts`:
  drop tools the builtin no longer declares and that are not ours; rewrite from
  the current frontmatter. A hand-written allowlist is left alone; a user
  addition to a Kady-shaped list is dropped (safe direction).
- The runtime uses Kady's shared Pi auth store. Default location
  `~/.kady/pi-agent/auth.json`; `KADY_PI_AGENT_DIR` relocates that app-scoped
  directory; an explicitly supplied `PI_CODING_AGENT_DIR` takes precedence
  and can intentionally share a standalone Pi directory. The value is
  inherited by child `pi` processes, so lead and subagents share one auth
  store.

## Tests

- Vitest, in `test/`. `KADY_PROJECTS_ROOT` is pointed at a temp dir via
  `vitest.config.ts` so tests do not touch user projects.
- Backend tests are also run in CI on `ubuntu-latest` and `windows-latest`
  (see `.github/workflows/tests.yml`).
- For new test files, follow the existing `*.test.ts` naming
  and put fixtures under `test/fixtures/`. Do not introduce a second runner.

## Helper venv

- Python helpers under `src/helpers/` run in a dedicated uv-managed venv
  (`src/helpers/pyproject.toml`, `.venv`), resolved via `helperPython()` and
  pre-warmed by `syncHelperVenv()` (`src/helpers-env.ts`) at `prep`/boot.
- All helpers share the exit-code contract `0` ok / `3` deps-missing /
  `4` not-found / `5` bad-value / `1` other, mapped to HTTP by the routes
  in `src/api/sci-helpers.ts` (`sciHelperFor`/`runSciHelper`).
- New scientific viewers in the frontend are view-only; the helper decode
  lives in `src/helpers/`. See `docs/file-previews.md` for user-facing
  coverage and `docs/superpowers/` for phased design notes.

## Sandbox boundary

- The agent's `bash` tool runs as the current OS user and is **not** an
  OS-level secret boundary. Kady-scoped `auth.json` is protected from other
  users, not from same-user shell processes. New sandbox instructions
  forbid reading credentials, but use a container/VM/separate account for
  adversarial content; see `docs/limitations.md`.
- Live PDF annotation sidecars and durable Modal jobs are cross-process
  shared via a file lock and atomic replacement; Modal jobs are server-owned
  and restart-recoverable through saved sandbox ids.
- `KADY_PROJECTS_ROOT` relocates `projects/`; default is the repo-root
  `projects/`. Tests redirect this to a temp directory.

## Model billing touchpoints

`server/src/cost/billing.ts`, `server/src/cost/ledger.ts`, and
`server/src/agent/subagent-bridge.ts` classify usage. The trio must stay in
sync or a local run defaults to `payg` and counts against the spend cap.
Local providers (Ollama, OpenAI-compatible) are billed `local`/`$0`. Pi
reports `usage.cost` inline for OpenRouter/API-key and Anthropic OAuth
usage; OpenAI Codex/Copilot/xAI OAuth usage records tokens plus
`listPriceUsd` with `costUsd: 0`. NVIDIA NIM is classified
`subscription` (Pi prices every NIM model at `$0`).

## Pi runtime vs. contributor policy

This `server/AGENTS.md` governs humans and coding agents editing this
backend. It does **not** automatically become prompt or policy for the Pi
runtime agent, whose project skills, agent definitions, and settings live
under each project sandbox (`projects/<id>/sandbox/.pi/`). Any change to
seeded runtime instructions remains a separately reviewed product behavior
change.
