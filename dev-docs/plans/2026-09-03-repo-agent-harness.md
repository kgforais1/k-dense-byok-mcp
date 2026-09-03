# Repository Agent Harness Implementation Plan

**Status:** Proposed — implementation has not started.

**Goal:** Make this fork straightforward and safe for a fresh human or coding
agent to navigate, change, verify, hand off, and maintain without turning
documentation into a second, conflicting implementation of the codebase.

## Why this work

The repository already has strong raw material: a detailed root `AGENTS.md`, a
fork-push guard, CI, release automation, a changelog, a maintenance log, and a
plan/archive convention. The missing piece is a coherent harness around those
assets: an agent should be able to discover the relevant instructions and
commands quickly, understand which document is authoritative, and leave a
bounded, useful state record for the next session.

This plan follows three useful external references:

- [OpenAI, Harness engineering](https://openai.com/index/harness-engineering/)
  (the page was identified but returned a site-level 403 from this environment;
  review it directly before adopting any OpenAI-specific recommendation).
- [Anthropic, Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents),
  especially its emphasis on incremental work, a verified clean state, durable
  progress records, and git history as continuation context.
- [AGENTS.md](https://agents.md/), for a portable, predictable instruction
  location and narrowly scoped nested instructions.

## Design decisions

### 1. Treat guidance as a layered interface, not one giant document

Keep `AGENTS.md` as the cross-agent entry point and policy boundary. It should
contain only information needed on almost every task: repository map, hard
constraints, command entry points, source-of-truth rules, and links to deeper
documents. Move detailed, volatile explanations to their owning documents.

Add nested instructions only where their rules genuinely differ:

| Scope | Proposed file | Purpose |
|---|---|---|
| Repository | `AGENTS.md` | Orientation, safety constraints, navigation, lifecycle, shared commands. |
| Backend | `server/AGENTS.md` | Fastify/Pi conventions, backend test boundaries, storage and security cautions. |
| Frontend | `web/AGENTS.md` | Next.js/React conventions, viewer and browser-test expectations. |
| Automation | `.github/AGENTS.md` | Workflow permissions, action pinning, secret and release constraints. |

Do not add a nested file merely to mirror parent text. Closest-scope guidance
must link upward for inherited constraints and state only its delta.

### 2. Establish explicit sources of truth

The harness will publish this precedence order:

1. Explicit user request and repository safety rules.
2. Merged code, tests, and CI configuration (actual behavior).
3. The issue/PR and its accepted implementation plan (intent and scope).
4. Current branch handoff record (temporary continuation summary).
5. Narrative documentation.

This prevents a stale handoff, TODO, or architecture note from silently
overriding tested behavior. Links should point to a canonical page rather than
copying commands, release rules, or architecture claims into multiple files.

### 3. Make common work discoverable and deterministic

Create a small, dependency-free command hub rather than asking agents to
infer the correct package and command. Root scripts should delegate to the
existing server/web scripts; they must not change CI policy or mask failures.

Initial commands:

- `npm run status` — branch, worktree, and active-plan/handoff discovery.
- `npm run verify` — documented local verification ladder, with explicit
  component commands and an opt-in full suite.
- `npm run docs:check` — validate internal Markdown links, required indexes,
  plan metadata, and handoff schema; no network access.
- `npm run repo:map` — print the concise architectural map and document entry
  points generated from a maintained manifest, not a fragile filesystem dump.
- `npm run handoff:check` — reject malformed or expired active handoffs.

The implementation should choose one portable Node script or small set of
Node scripts under `scripts/`; no shell-only task runner. The commands will be
documented as a navigation aid, not as authorization to run expensive or
state-changing operations automatically.

### 4. Use durable handoffs, but never a global mutable coordination file

For work that crosses an agent/session boundary, add a branch-local,
versioned handoff in `dev-docs/handoffs/active/`. Its frontmatter records the
branch, plan/issue, owner (if known), status, and `updated` date. Its body has
fixed sections: scope, decisions, changed files, verification with outcomes,
known failures, blockers, and the one recommended next action.

Handoffs are required only when work will continue after the current session
or another agent is explicitly asked to take over. They are summaries, not
locks: git branches, commits, and PRs remain the coordination mechanism.
Archive/remove a handoff when the work merges, is abandoned, or has been
superseded. This avoids a shared `current-state.md` becoming both stale and a
merge-conflict hotspot.

### 5. Give documentation a maintenance system

Create a contributor/developer documentation index and an ownership/freshness
table. Each canonical document gets an owner area, audience, and update
triggers (for example, changing a route requires its API/architecture doc
review; changing scripts or CI requires command/verification doc review).
`docs:check` catches structural drift; review templates and a lightweight
scheduled audit catch semantic drift. It must report rather than rewrite
documentation or open automated code changes.

## Proposed information architecture

```text
README.md                         Human product overview and local quick start
AGENTS.md                         Cross-agent entry point and hard constraints
CONTRIBUTING.md                   Human contributor workflow; links into docs/development
SECURITY.md                       Disclosure route and security expectations

docs/
  development/
    README.md                     Developer documentation index and ownership/freshness table
    architecture-map.md           Package/module entry points and data-flow map
    verification.md               Verification ladder and CI/local mapping
    workflow.md                   Branch, plan, handoff, PR, release, and archive lifecycle

dev-docs/
  todo.md                         Prioritized, non-authoritative roadmap
  plans/                          Accepted/proposed implementation plans
  plans/completed/                Merged plan archive
  handoffs/active/                Short-lived, branch-scoped continuation records
  handoffs/completed/             Closed records retained only when useful for audit
  maintenance-log.md              Completed maintenance/security/infrastructure record

scripts/
  repo.mjs                        Portable command hub and read-only status/map helpers
  docs-check.mjs                  Deterministic documentation/handoff validation
  repo-manifest.json              Curated navigation and documentation metadata
```

`SECURITY.md`, `CODEOWNERS`, issue forms, and a PR template need a maintainer
decision on contact/ownership before they are enabled. In particular, do not
invent a private security address or assign review owners who have not agreed
to that role.

## Implementation sequence

### Phase 0 — Baseline and decisions

- [ ] Inventory every existing guidance, policy, workflow, script, and
  contributor-facing document; record canonical owner and duplication risks.
- [ ] Agree the proposed document taxonomy, plan/handoff retention period,
  default verification ladder, and the responsible security contact.
- [ ] Capture a baseline: time for a fresh agent to locate the relevant module,
  select checks, and identify current work from the repository alone.

**Exit criteria:** The taxonomy and source-of-truth order are accepted; no
files are moved or deleted in this phase.

### Phase 1 — Navigation and scoped guidance

- [ ] Refactor root `AGENTS.md` into an index plus universal constraints,
  preserving all existing fork, hook, release, version, platform, and harness
  invariants through links or scoped files.
- [ ] Add `server/AGENTS.md`, `web/AGENTS.md`, and `.github/AGENTS.md` with
  only scope-specific deltas and links to their primary docs/tests.
- [ ] Add `docs/development/README.md` and `architecture-map.md`; link them
  from `README.md`, `AGENTS.md`, and each package instruction file.
- [ ] Validate that links work when opened from their owning directory and that
  neither a human nor an agent needs to scan the full tree to find an entry
  point, persistence boundary, or test suite.

**Exit criteria:** A fresh agent can answer “where does this change belong?”
and “what do I run?” from the nearest instruction file in under five minutes.

### Phase 2 — Command hub and verification contract

- [ ] Implement the portable Node command hub and root script aliases.
- [ ] Write `docs/development/verification.md`: fast targeted checks, package
  checks, full local checks, CI-only matrix coverage, and expected runtime.
- [ ] Ensure commands fail loudly, preserve original exit codes, avoid network
  writes, and never bypass hooks or CI gates.
- [ ] Add tests for command parsing and manifest validation; run the commands
  on macOS/Linux/Windows in the existing launcher matrix where appropriate.

**Exit criteria:** The documented commands and CI use the same underlying
checks; a failed command says where to look next without hiding the failure.

### Phase 3 — Policies and workflow clarity

- [ ] Add `CONTRIBUTING.md` with setup, scope selection, branching, plan,
  verification, PR, and archival workflow; it links rather than duplicates.
- [ ] Add `SECURITY.md` only after a disclosure contact and triage process are
  approved. Include scope, supported versions, secret-handling expectations,
  and public-reporting guidance.
- [ ] Add a PR template with a small mandatory evidence section: scope,
  tests/commands run, documentation touched, security/privacy impact, and
  handoff disposition.
- [ ] Decide whether `CODEOWNERS` is useful for this fork. If no stable human
  owners exist, document the decision and defer it rather than adding a
  misleading file.

**Exit criteria:** A contributor can make a safe PR without knowing local
folk knowledge, and policy documents have named owners/review cadence.

### Phase 4 — State coordination and handoff

- [ ] Add the handoff schema, examples for code/docs/infrastructure work, and
  an archive/removal rule to `docs/development/workflow.md`.
- [ ] Implement `handoff:check` for branch-name match, required fields, ISO
  dates, referenced-plan existence, and closed-state placement.
- [ ] Add a short “resume protocol” to root guidance: inspect status, recent
  commits, active handoff, plan/issue, then run the smallest relevant health
  check before changing code.
- [ ] Add a PR closing checklist that requires handoff archival/removal and
  plan/maintenance/changelog updates when applicable.

**Exit criteria:** An agent can resume a nontrivial branch from repository
state alone, while parallel branches do not contend over one mutable file.

### Phase 5 — Documentation gardening and regression protection

- [ ] Implement `docs:check` for local links, required headings/frontmatter,
  manifest coverage, orphaned active handoffs, and plan/archive placement.
- [ ] Add a CI job that runs documentation checks on every PR, including
  documentation-only PRs (the existing test workflow intentionally skips many
  doc-only pushes, so this must be separate or its path filters adjusted).
- [ ] Add a scheduled, report-only workflow that opens or updates a labeled
  maintenance issue when docs checks or stale-date thresholds fail; it must
  not edit docs or close issues on partial failures.
- [ ] Add deterministic “agent journey” fixtures: navigation, scoped
  instructions, verification selection, and handoff validation. These test the
  harness without invoking an LLM or storing prompts/credentials.

**Exit criteria:** Structural documentation drift and broken handoffs are
caught before merge, and semantic review triggers are visible to maintainers.

### Phase 6 — Rollout and measurement

- [ ] Pilot the harness on two representative changes (one backend behavior
  change and one frontend/docs or CI change); collect friction and false
  positive reports.
- [ ] Tighten wording and commands from pilot results; remove any duplicated
  or unused artifact rather than preserving it “just in case.”
- [ ] Record final decisions in the maintenance log and move this plan to
  `dev-docs/plans/completed/` only after its implementation PR merges.

**Exit criteria:** The baseline navigation exercise improves measurably, all
new checks pass in CI, and maintainers agree the ongoing gardening load is
proportionate.

## Guardrails

- The harness must support humans and multiple agent tools; no vendor-specific
  instruction file is the sole source of a required rule.
- Guidance cannot authorize secret access, destructive commands, hook bypasses,
  upstream pushes, or external writes that repository policy does not permit.
- Do not build a database, daemon, or lock service for coordination until
  versioned branch artifacts and git/PR state demonstrably fail.
- Do not make documentation-only maintenance depend on an LLM or remote service.
- Keep checks deterministic, cross-platform, and bounded. A scheduled check
  reports incomplete data rather than declaring the repository healthy.
- Changes to this harness need their own targeted tests and a manual fresh-agent
  navigation review.

## Acceptance measures

| Outcome | Evidence |
|---|---|
| Faster orientation | Fresh-agent exercise identifies scope, commands, and current state in under five minutes. |
| Safe execution | Every documented verification command maps to a real command and preserves failures. |
| Clear ownership | Canonical docs have audience, update triggers, and no conflicting copies of policy. |
| Resumable work | A valid handoff plus git history lets a new session state next action, risks, and verification status. |
| Low maintenance | Doc checks run locally and in CI without network access; scheduled audits report only. |
| No policy regression | Fork guard, release rules, exact harness pins, privacy/security guidance, and existing CI checks remain intact. |

## Open questions to resolve before Phase 3

1. Who receives private security reports and owns triage for this fork?
2. Which people or teams, if any, should be represented in `CODEOWNERS`?
3. Should active handoffs be retained in git after merge, or deleted except
   when they document an incident/long-running operational decision?
4. What duration should distinguish a quick task (no handoff) from
   cross-session work (handoff required)?
5. Which full local verification command is acceptable as the default before a
   PR, given the current backend/frontend suite duration?
