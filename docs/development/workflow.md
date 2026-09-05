# Workflow — Branch, Plan, Handoff, PR & Archive Lifecycle

This doc is the lifecycle reference for the repository harness described in
[`../../AGENTS.md`](../../AGENTS.md) and planned in
[`../../dev-docs/plans/completed/2026-09-03-repo-agent-harness.md`](../../dev-docs/plans/completed/2026-09-03-repo-agent-harness.md).
For the developer documentation index, category definitions, and the
ownership/freshness table see [`README.md`](README.md). For the command-to-CI
mapping see [`verification.md`](verification.md). For versioning and changelog
rules see [`release-policy.md`](release-policy.md).

## Lifecycle at a glance

```
Branch (kebab-case, from main)
  └─ Plan (dev-docs/plans/YYYY-MM-DD-<slug>.md) — required before substantial work
       └─ Active handoff (dev-docs/handoffs/active/<branch>.md) — only when crossing a session/agent boundary
            └─ PR (evidence: Scope · Tests · Docs · Security · Handoff disposition)
                 └─ PR closing checklist: archive plan · remove/condense handoff · CHANGELOG · maintenance log · trim TODO
                        └─ Merge to main (no post-merge follow-up — closing checklist is the finish line)
```

The closing checklist is **part of the implementing PR**, not a follow-up. The
PR is not "done" while its plan still lives in `dev-docs/plans/`, the matching
TODO entry is still open, the changelog/maintenance-log entries are still
missing, or `npm run verify -- docs` still fails on a pointer the PR created.
All four records are distinct — do not merge them. The table in
[`release-policy.md#changelogmd-versus-maintenance-logmd`](release-policy.md#changelogmd-versus-maintenance-logmd)
is the reference.

## Branch lifecycle

- **Create from `main`:** `git checkout main && git pull && git checkout -b <kebab-case-slug>`.
  Keep branches short-lived and focused; one PR per branch.
- **Fork guard:** This repo is `kgforais1/k-dense-byok-mcp`. Never push to
  or open PRs against upstream. Always pass
  `--repo kgforais1/k-dense-byok-mcp` to `gh pr create`. The pre-push hook
  (`.githooks/pre-push`, activated by `start.mjs` via `git config core.hooksPath .githooks`)
  blocks pushes to any non-fork remote. Never use `git push --no-verify`
  without explicit user confirmation.
- **Verification before every push:** run the smallest relevant ladder
  (`npm run verify -- fast` always; `server`/`web`/`docs` as the touch set
  requires — see [`verification.md`](verification.md)) and surface repo
  state with `npm run status` (branch, dirty files, recent commits, active
  handoffs).

## Plan lifecycle

A plan is **required** before substantial implementation: any change that spans
packages, introduces a new route/tool/storage boundary, changes the harness, or
needs phased review. Trivial single-file fixes and docs-only typos do not need
a plan — state the rationale in the PR's Scope section instead.

- **Location:** active plans live in `dev-docs/plans/YYYY-MM-DD-<slug>.md`.
  The implementing PR moves the plan to `dev-docs/plans/completed/` and
  flips its Status line to `Completed and merged in PR #...` **as part of
  the same PR's closing checklist** — never as a follow-up after merge.
  The file path is captured by `docs:check`; leaving the plan in
  `dev-docs/plans/` keeps the next branch's `npm run verify -- docs` red
  and the harness considers that PR unfinished.
- **Scaffold (refuses to overwrite):**
  `npm run work:plan -- --slug <kebab-case> [--title "..." --branch <name>]`
  (renders `dev-docs/templates/plan.md` with branch/date/slug fields).
- **Template headings** (`dev-docs/templates/plan.md`): Title/Status/Goal,
  Why this work, Design decisions, Proposed information architecture / file
  changes, Implementation sequence (phases with exit criteria), Guardrails,
  Acceptance measures.
- **Status values:** `Proposed` (draft) → `Accepted` (reviewed, implementation
  starts) → `Completed and merged in PR #...` (set in the implementing PR's
  closing checklist, then move to `dev-docs/plans/completed/`). Do not
  invent other statuses. A plan in `dev-docs/plans/` whose Status is
  `Completed` is a bug — the file should already have moved.
- **Source-of-truth order:** merged code/tests/CI win over any plan sentence.
  When the plan and the implementation disagree, the code wins — fix the doc in
  the same PR. A stale plan never silently overrides tested behavior.

## Handoff lifecycle (state coordination)

Handoffs are **branch-local, short-lived summaries** for work that will
continue after the current session or that another agent is explicitly asked to
take over. They are **not** a lock, a global task board, or long-term history.
Git branches, commits, and PRs remain the coordination mechanism.

### Schema

Every active handoff is one Markdown file in `dev-docs/handoffs/active/`:

```yaml
---
branch: "branch-name"          # must match git rev-parse --abbrev-ref HEAD
plan: "dev-docs/plans/2026-09-01-foo.md"  # required local plan path, must exist
owner: "alice"                 # optional
status: "active"               # or in-progress
updated: "2026-09-03"          # ISO YYYY-MM-DD, not a timestamp
---
```

Body headings (all required — `npm run handoff:check` validates the starred ones):

- `## Scope` — *what this handoff covers.*
- `## Decisions`
- `## Changed files`
- `## Verification` — *commands run, outcomes, evidence links.*
- `## Known failures` / `## Known failures / Rough edges`
- `## Blockers`
- `## Next action` — *the single thing the next session should do first.*

Optional frontmatter `owner` is allowed. Any other required field that is
missing, empty, or malformed fails `handoff:check`. Use the template
`dev-docs/templates/handoff.md` and the scaffolder
`npm run work:handoff -- --plan <path> [--slug <s> --branch <name>]` (refuses
to overwrite; prints the target path before writing and leaves substantive
fields for the author).

### Examples by kind

- **Code:** scope names the packages/routes touched; decisions record the
  interface choice; verification lists `npm run verify -- server` / `web` with
  pass/fail and a log excerpt or CI link; next action names the exact file
  and test to run next.
- **Docs:** scope names the doc index rows and manifest entries; verification
  lists `npm run verify -- docs` / `handoff:check`; next action is the doc
  section to finish.
- **Infrastructure (CI/tooling):** scope names the workflow and runner matrix;
  verification links the CI run on the branch; next action names the matrix
  change or pin to land next.

### Validation — `handoff:check`

`npm run handoff:check` (part of `npm run verify -- docs`) enforces,
deterministically and offline:

- Every `dev-docs/handoffs/active/*.md` has YAML frontmatter with non-empty
  `branch`, `plan`, `status`, `updated`.
- `updated` is ISO `YYYY-MM-DD`; not in the future and not stale
  (> 14 days — the `maxAgeDays` threshold in `scripts/repo.mjs`).
- `branch` matches the current git branch (parametrizable for tests).
- `plan` resolves to an existing file.
- The body has `## Scope`, `## Verification`, and `## Next action` headings.

`npm run verify -- docs` runs this check. There is currently no CI job for the
docs ladder (the plan's Phase 5 docs job is still pending); run it locally
before requesting review. The check reports rather
than rewrites — it never edits a handoff or opens an automated fix.

### Removal rule

Remove an active handoff when **any** of these is true:

- The work merges (PR merged to `main`).
- The work is abandoned (branch deleted or superseded).
- The work is superseded by a newer handoff or plan.

If the handoff records an incident or enduring operational decision, **distill
that fact into [`../../dev-docs/maintenance-log.md`](../../dev-docs/maintenance-log.md)**
instead of retaining the file. Use `npm run work:maintenance -- --pr <n> [--category <name>]`
to scaffold the entry. Do not keep a second state record — a shared
`current-state.md` would become both stale and a merge-conflict hotspot.

## Resume protocol

When picking up any branch (human or coding agent), run this sequence **before
changing code**:

1. **Inspect status:** `npm run status` — prints current branch, dirty
   status, recent commits, and every `dev-docs/handoffs/active/*.md` with its
   frontmatter. Also run `git status` and `git diff --stat` for the working
   tree you are about to change.
2. **Inspect recent commits and the plan:**
   ```bash
   git log --oneline -10
   cat dev-docs/handoffs/active/<branch>.md   # if present — read the required plan
   cat $(grep -m1 '^plan:' dev-docs/handoffs/active/<branch>.md | cut -d'"' -f2)
   ```
   The plan is `handoff.frontmatter.plan`. An issue may be linked from the
   plan or handoff body, but it is **not** a substitute for the required plan
   reference. The source-of-truth order is
   `AGENTS.md` § *Source of truth* — merged code/CI win over any handoff.
3. **Run the smallest relevant health check:**
   - Always: `npm run verify -- fast` (<2 s — manifest + hygiene).
   - Plus the ladder that matches the touch set (`server` / `web` / `docs`)
     from [`verification.md`](verification.md).
   - Before requesting review: `npm run verify -- all` (fast + server + web
     + docs, 2–6 min). The hub preserves the original exit code — a green
     run is the only pass signal.
4. **Then edit:** apply the handoff's `## Next action` (one sentence) as the
   first change, and append verification evidence to the handoff before
   ending the session. Never leave a handoff's `updated` more than a day
   behind the work it describes.

For deterministic validation without an LLM or network, also run
`npm run docs:check` (alias for `npm run verify -- docs`): it checks local
Markdown links, required headings, manifest target/category coverage, orphaned
active handoffs, and plan/archive placement. See `scripts/repo.mjs` for the
exact checks.

## PR lifecycle

- **Template:** [`.github/pull_request_template.md`](../../.github/pull_request_template.md)
  — all five evidence sections are mandatory: **Scope**, **Commands/Tests run
  with evidence**, **Docs touched**, **Security/Privacy impact**, **Handoff
  disposition**. Reviewers reject PRs that omit them.
- **Target:** `kgforais1/k-dense-byok-mcp` — always pass
  `--repo kgforais1/k-dense-byok-mcp` to `gh pr create`.
- **Docs duty:** when a canonical doc's declared source of truth changes,
  update the doc and its ownership/freshness row in
  [`README.md#ownership-and-freshness`](README.md#ownership-and-freshness) in
  the **same PR**. Link rather than duplicate rules from any `AGENTS.md`.
- **Release notes:** user-facing behavior → `CHANGELOG.md` `Unreleased`
  (Keep a Changelog categories); internal triage/dependency/CI/operational
  work → `dev-docs/maintenance-log.md` (append-only, after merge). See
  [`release-policy.md`](release-policy.md).
- **Closing checklist** (also rendered inside the PR template) — complete
  in the **same PR** that ships the work, before requesting review:

  - [ ] Handoff archived or removed from `dev-docs/handoffs/active/` (or N/A
        — no handoff). If the handoff records an enduring decision, distill
        that fact into the maintenance log in the same PR.
  - [ ] Plan moved to `dev-docs/plans/completed/` and its Status line
        updated to `Completed and merged in PR #<this PR>` (or N/A — no
        plan). The file path change must happen in this PR so the next
        branch's `docs:check` is green.
  - [ ] `CHANGELOG.md` `## [Unreleased]` updated when shipped behavior
        changed (or N/A). Release prep later moves entries under
        `[X.Y.Z] - YYYY-MM-DD`.
  - [ ] `dev-docs/maintenance-log.md` appended when security, dependency,
        CI, or operational work applies (or N/A — scaffold via
        `npm run work:maintenance -- --pr <this PR>`).
  - [ ] `dev-docs/todo.md` entry for this work **deleted** (not checked
        off) on completion. A checked-off box is a bug — the entry has
        shipped, so it no longer belongs on the roadmap (or N/A — no
        matching TODO entry).
  - [ ] `npm run verify -- docs` is green on the PR branch. The manifest
        git-hygiene gate will reject any PR that touches
        `scripts/repo-manifest.json` without committing the change.

## Archive lifecycle

The "archive" happens in the **implementing PR**, not after it. The
branch is not done while any of the following still points at the
pre-completion state.

- **Plans:** `dev-docs/plans/<plan>.md` → `dev-docs/plans/completed/<plan>.md`
  in the same PR that ships the work. Move the file, update its Status
  line, link this PR. Do not archive proposed plans that never shipped —
  leave them in `dev-docs/plans/` until you either implement them or
  explicitly remove them.
- **Handoffs:** `dev-docs/handoffs/active/<branch>.md` → **removed** in
  the same PR. No `handoffs/completed/` directory — git history and the
  maintenance log (for incidents) are the durable record.
- **TODO entries:** `dev-docs/todo.md` rows for the shipped work are
  **deleted**, not ticked, in the same PR. The roadmap only contains
  unstarted / in-progress work.
- **Changelog:** `CHANGELOG.md` `## [Unreleased]` is updated in the
  implementing PR; release prep later moves entries under
  `[X.Y.Z] - YYYY-MM-DD` (see [`release-policy.md`](release-policy.md)).
- **Maintenance log:** append-only at `dev-docs/maintenance-log.md`; scaffold
  via `npm run work:maintenance`. The implementing PR appends the entry
  when the category applies — the entry ships with the code in the same
  PR so the archive, the distilled decision, and the running code do not
  drift.
- **Artifacts to keep linked:** the archived plan links the PR, the PR
  links the archived plan and (when applicable) the removed handoff, and
  the maintenance log entry links the PR. No mutable coordination file
  needs to be retained for an agent to reconstruct what happened — `git
  log`, the archived plan, the closed PR, and the maintenance log
  suffice.

## Adding a new document or template

Follow [`README.md#adding-a-new-document`](README.md#adding-a-new-document):
pick the smallest category, add the ownership/freshness row in the same PR,
and add a manifest entry to `scripts/repo-manifest.json` if a coding agent
should discover it via `npm run repo:map`. Do not add a document that
duplicates a rule already in any `AGENTS.md` — link instead. Templates live
under `dev-docs/templates/` and are validated by `npm run verify -- docs`.
