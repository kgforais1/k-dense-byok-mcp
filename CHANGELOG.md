# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Local models declare their real context window** ([#35](https://github.com/kgforais1/k-dense-byok-mcp/pull/35)):
  - Kady asked neither local server how big the model's context window was; it hardcoded 32,768 for all of them. A live LM Studio model reports 262,144, and Kady's own prompt is ~39,600 tokens against a 16,384-token compaction reserve — so the declared floor exceeded the declared ceiling and no local model could run inside its own declared budget. The window is now read from each server: Ollama's `/api/tags` and `/api/ps`, LM Studio's `/api/v0/models`.
  - The **currently loaded** figure wins over the architectural maximum where both are known, because that is what the request is measured against. Both servers diverge by default — LM Studio loads at half its maximum on a default install, and an Ollama model whose Modelfile pins `num_ctx` serves the smaller number with nothing configured.
  - Opening the model picker is what refreshes this. Ollama rows are correct on the first open; LM Studio's figure arrives on the second, and an unknown figure shows no badge rather than a wrong one. Entries are overwritten, never expired, so a large model cannot silently decay to the fallback.
  - When no server answers, the declared window is 128,000 — a floor that clears Kady's own prompt rather than a guess at your hardware. A model whose real window is genuinely too small now fails with a context-overflow message naming the numbers, instead of returning an empty reply. To override a figure, declare `contextWindow` per model under **Custom model servers**.

- **Session management, in the browser and over MCP** ([#20](https://github.com/kgforais1/k-dense-byok-mcp/pull/20), [#21](https://github.com/kgforais1/k-dense-byok-mcp/pull/21)):
  - A chat can be deleted from the history menu, by mouse or keyboard. Deleting takes the session's notebook, annotations, provenance and durable run records with it; the project's cost ledger is kept, because the money was spent. A session with a run in flight is refused rather than deleted underneath it. Clearing the run records is best-effort: if it fails, the transcript is still gone, and `poll_run` can answer for a session `get_session_history` now 404s on until the seven-day retention sweep collects it.
  - Sessions created over MCP are marked in the history menu, so it is clear which ones another tool made.
  - Two MCP tools for the same thing: `list_research_sessions` (this project's stored sessions, newest first, each labelled `headless`) and `delete_research_session`. A scripted client can now clean up after itself instead of requiring the browser.
  - `poll_run` reports `producedOutput` on a terminal status, so a client can tell a finished run that emitted nothing from one that answered. A `done` run with `producedOutput: false` is a failed attempt worth retrying, not an empty result to report. The key is absent on `running` and `unknown`, where nothing is knowable — test for the key rather than for a falsy value.
- **Inbound MCP server — Phase 2 tool surface** ([#18](https://github.com/kgforais1/k-dense-byok-mcp/pull/18)):
  - Completed the opt-in `/mcp-server` Streamable HTTP endpoint with the full decided tool subset: `list_projects`, `create_research_session`, `get_session_history`, `start_research_run`, and `poll_run`.
  - `start_research_run` returns a run id immediately and mirrors the REST run body, including inline `images: [{data, mimeType}]` attachments; `poll_run` reads the live run broker first and the durable terminal record afterwards, so a completed run stays retrievable past the broker's ~30s retention.
  - MCP-created sessions are headless: the blocking `interview` tool is disabled and replaced with system-prompt guidance that tells the model to choose and state an interpretation instead of stalling or silently guessing.
  - New durable per-session headless marker so a session evicted from the live registry and cold-opened from disk does not silently regain `interview`.
  - Added `zod` as an exactly-pinned direct dependency of `server/` (`4.4.3`, matching the MCP SDK's own resolution) for tool input schemas.
- **Repository Agent Harness** ([#11](https://github.com/kgforais1/k-dense-byok-mcp/pull/11)):
  - Layered agent guidance: root `AGENTS.md` index + source-of-truth precedence, scoped `AGENTS.md` for `server/`/`web/`/`.github/`, and `CLAUDE.md`/`GEMINI.md` compatibility pointers.
  - Contributor policies: `CONTRIBUTING.md`, `SECURITY.md` (GitHub-advisory route), and a five-section PR template with closing checklist.
  - Developer documentation set under `docs/development/` (index, architecture map, verification ladder, workflow, release policy) with an ownership/freshness table.
  - Dependency-free, offline, fail-closed command hub (`scripts/repo.mjs`) exposing `status`, `map`, `verify {fast,server,web,docs,all}`, `handoff:check`, `release:check`, and `work:{plan,handoff,maintenance}` scaffolders, plus a structural `docs-check` validator and curated `scripts/repo-manifest.json`.
- **CI Hardening & Quality Gates** ([#8](https://github.com/kgforais1/k-dense-byok-mcp/pull/8)):
  - Top-level least-privilege token permissions (`contents: read`) in GitHub Actions workflow.
  - Workflow concurrency with PR cancellation (`cancel-in-progress: ${{ github.event_name == 'pull_request' }}`).
  - Job timeout limits (15m) and build failure artifact capture (`web/.next/`).
  - Full frontend verification pipeline: `typecheck` (`tsc --noEmit`), `lint` (`next lint`), `build` (`next build`), and `test` (`vitest`).
  - Expanded `paths-ignore` for documentation and markdown file changes (`docs/**`, `dev-docs/**`, `**/*.md`).
- **PDF Viewer Initialization Unit Tests & Polyfills** ([#8](https://github.com/kgforais1/k-dense-byok-mcp/pull/8)):
  - Exported and documented `installMapUpsertPolyfill`, `MAP_UPSERT_POLYFILL_SRC`, and `buildWorkerUrl`.
  - Added strict HTTP status checking (`if (!r.ok) throw`) to prevent HTML error pages from being wrapped in worker Blobs.
  - Added unit tests covering Map upsert idempotency, native preservation, prepended worker polyfills, and network/404 fallbacks.
  - Added `IntersectionObserverStub` in `web/vitest.setup.ts` supporting constructor options, element tracking (`observe`/`unobserve`/`disconnect`), and test event simulation (`trigger()`).
- **Security & Rate Limiting** ([#7](https://github.com/kgforais1/k-dense-byok-mcp/pull/7)):
  - Added `@fastify/rate-limit` for sandbox routes.
  - Added Dependabot configuration (`.github/dependabot.yml`) for `server/` and `web/` packages.
- **Fork Safety & Architecture Documentation** ([#3](https://github.com/kgforais1/k-dense-byok-mcp/pull/3)):
  - Pre-push git hook (`.githooks/pre-push`) guarding against accidental upstream pushes.
  - Added fork policies and architecture guidelines in `AGENTS.md` and `dev-docs/`.

### Changed
- **Fork attribution cleanup** ([#34](https://github.com/kgforais1/k-dense-byok-mcp/pull/34)): README no longer shows the K-Dense social badges (MIT license badge kept), the unverifiable "149 skills" figure is replaced by the catalogue source in four prose sites, all 28 user docs carry a one-line fork notice, and `docs:check` now asserts the workflows (326) / databases (229) counts match the data files.
- **Single run-start path** ([#18](https://github.com/kgforais1/k-dense-byok-mcp/pull/18)): `prepareRun` no longer writes status codes onto a `FastifyReply`; it returns a typed rejection, and the new `beginRun` is shared by `POST /sessions/:id/run` and the MCP adapter. The SSE route attaches its stream as an observer of the already-detached run rather than owning it.
- Standardized `npm ci` across both backend and frontend GitHub Actions jobs for deterministic dependency installation.
- Standardized `"typecheck": "tsc --noEmit"` script in `web/package.json`.
- Configured experimental React 19 compiler ESLint rules to `warn` in Next.js 16 flat config for progressive codebase modernization.
- Reorganized planning artifacts: moved plans into `dev-docs/plans/` (with completed plans archived in `dev-docs/plans/completed/`) and tracked roadmap in `dev-docs/todo.md`.

### Fixed
- **Security: dependency alerts** ([#24](https://github.com/kgforais1/k-dense-byok-mcp/pull/24)): updated `next` to 16.3.4, clearing two critical advisories (CVE-2026-75604, GHSA-2xp9-vwfh-vxw4) along with the `postcss` and `sharp` advisories that are only fixable through it. A further round of transitive updates in both packages clears `fastify`, `find-my-way`, `ip-address`, `qs`, `protobufjs`, `body-parser`, `browserslist`, `lodash-es`, `mermaid`, `picomatch`, `uuid` and others. No behaviour change is expected; this is dependency maintenance recorded here because the advisories are user-relevant.
- **Transcript lookup and path containment** ([#20](https://github.com/kgforais1/k-dense-byok-mcp/pull/20)):
  - A session is identified by its transcript header rather than its filename, so a stray file named after a session id can no longer shadow or hide the real one. The header is read with a bounded scan instead of loading the whole transcript.
  - `containedIn` refuses an absolute name outright, and its error names neither the root nor the offending path — an absolute name that happened to land inside the root previously passed the containment check without the root taking part.

## [0.9.12] - 2026-09-02

### Added
- Tagged release baseline for K-Dense BYOK fork.
