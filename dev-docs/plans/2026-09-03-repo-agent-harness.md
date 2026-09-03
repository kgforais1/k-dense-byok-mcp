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
- [GitHub Spec Kit](https://github.com/github/spec-kit), as a repository-first
  example of making a specification → plan → task → implementation workflow
  repeatable with templates and commands. This plan adopts the useful
  standardization ideas, not Spec Kit as a mandatory dependency or process.
- [Claude Code project memory](https://code.claude.com/docs/en/memory) and
  [Gemini CLI `GEMINI.md` guidance](https://geminicli.com/docs/cli/gemini-md/),
  which confirm that both tools have their own project-instruction filenames.
- [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
  [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html), for a
  release record that serves users as well as maintainers.

The relevant common lesson is not to build a generic agent-control system. It
is to make repository state cheap to recover: give work a stable home, provide
small templates for recurrent artifacts, expose a short command path to the
right check, and retain git history as the verified account of what changed.

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

### 1a. Support agent-specific filenames without creating competing policies

`AGENTS.md` is the canonical repository instruction source. Add small regular
files, not symlinks, at the root for tools that do not automatically read it:

| File | Contents | Reason |
|---|---|---|
| `CLAUDE.md` | A short compatibility pointer: read and follow `AGENTS.md`; it is canonical. | Claude Code project memory discovers `CLAUDE.md`. |
| `GEMINI.md` | The same short pointer. | Gemini CLI discovers `GEMINI.md`. |

Where a scoped `server/AGENTS.md`, `web/AGENTS.md`, or `.github/AGENTS.md` is
introduced, add matching scoped compatibility pointers only if testing shows
the corresponding tool needs automatic closest-directory discovery. A pointer
must say to read the sibling `AGENTS.md` and then root `AGENTS.md`; it must not
copy rules. `docs:check` will validate the exact pointer template and prevent
the alias files from accreting a second policy.

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

Initial commands, added as explicit aliases to the existing root
`package.json`, are:

- `npm run status` — current branch, recent commits, and active-plan/handoff
  discovery.
- `npm run verify` — documented local verification ladder, with explicit
  component commands and an opt-in full suite.
- `npm run docs:check` — validate internal Markdown links, required indexes,
  manifest targets, standard-template headings, and the active-handoff schema;
  no network access.
- `npm run repo:map` — print the concise architectural map and document entry
  points generated from a maintained manifest, not a fragile filesystem dump.
- `npm run handoff:check` — reject malformed or expired active handoffs.

The implementation should choose one portable Node script or small set of
Node scripts under `scripts/`; no shell-only task runner. The commands will be
documented as a navigation aid, not as authorization to run expensive or
state-changing operations automatically.

`repo-manifest.json` is a deliberately small, reviewed source: the author who
adds, removes, or relocates a manifest-listed entry point updates it in the
same PR. `docs:check` verifies that every listed target exists and that each
required category has an entry; it does not attempt to infer architecture from
the filesystem. `docs/development/README.md` owns the category definitions and
the manifest update rule.

### 4. Use durable handoffs, but never a global mutable coordination file

For work that crosses an agent/session boundary, add a branch-local,
versioned handoff in `dev-docs/handoffs/active/`. Its frontmatter records the
branch, plan/issue, owner (if known), status, and `updated` date. Its body has
fixed sections: scope, decisions, changed files, verification with outcomes,
known failures, blockers, and the one recommended next action.

Handoffs are required only when work will continue after the current session
or another agent is explicitly asked to take over. They are summaries, not
locks: git branches, commits, and PRs remain the coordination mechanism.
Remove a handoff when the work merges, is abandoned, or has been superseded.
If it records an incident or enduring operational decision, distill that fact
into the maintenance log instead of retaining a second state record. This
avoids a shared `current-state.md` becoming both stale and a merge-conflict
hotspot.

### 4a. Keep contributor guidance separate from runtime Pi-agent policy

This harness governs humans and coding agents changing this repository. It
does not automatically become a prompt or policy source for the Pi runtime
agent, whose project skills, agent definitions, and settings live under each
project sandbox. Phase 1 must document that boundary and link the relevant
runtime locations from `server/AGENTS.md`; any change to seeded runtime
instructions remains a separately reviewed product behavior change.

### 5. Give documentation a maintenance system

Create a contributor/developer documentation index and an ownership/freshness
table. Each canonical document gets an owner area, audience, and update
triggers (for example, changing a route requires its API/architecture doc
review; changing scripts or CI requires command/verification doc review).
`docs:check` catches structural drift; review templates and a lightweight
scheduled audit catch semantic drift. It must report rather than rewrite
documentation or open automated code changes.

### 6. Separate change, maintenance, plan, and handoff records

The repository will make the following records distinct and link them when a
change needs more than one:

| Record | Purpose and timing | Required content | Not for |
|---|---|---|---|
| `CHANGELOG.md` | User-facing release notes. Update the `Unreleased` section in the implementing PR when shipped behavior changes; move entries under `[version] - YYYY-MM-DD` as part of release preparation. | Keep-a-Changelog categories (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`) and PR link where useful. | Internal cleanup narratives, exhaustive implementation detail, or every documentation typo. |
| `dev-docs/maintenance-log.md` | Internal, append-only record after merge for security triage, dependency work, CI/tooling, operational decisions, and non-obvious verification. | Date, PR/commit, category, summary, evidence, and follow-up if needed. | A substitute for the changelog or active state. |
| `dev-docs/plans/` | Proposed/accepted intent before substantial implementation. Archive only after merge. | Goal, constraints, interfaces, phases, acceptance checks, and decisions. | A live task board or a release note. |
| `dev-docs/handoffs/active/` | Short-lived continuation state for work crossing a session or agent boundary. | Scope, decisions, changed files, verification outcomes, blockers, and one next action. | Long-term history, a lock, or a replacement for commits/PRs. |

SemVer remains anchored to the existing single source of truth:
`server/package.json` version. For this local desktop app, "public contract"
means user-visible behavior, persisted project data, documented configuration
or environment variables, and supported local HTTP/API integrations; internal
refactors and undocumented implementation details are not contracts. A
compatible bug fix is a PATCH increment, a backward-compatible capability is a
MINOR increment, and a breaking public-contract change is a MAJOR increment.
The web package must not gain a second version. The existing release workflow
creates `v<version>` and release notes after `main` receives the version bump,
so contributors must not manually tag a release. A release-readiness script
should check the version policy and changelog shape, but never publish, tag, or
alter the version.

### 7. Standardize repeated work with small templates and checked generators

Add templates under `dev-docs/templates/` for a plan, active handoff,
maintenance-log entry, and release-readiness checklist. A portable Node helper
may create a new artifact from these templates with branch/date/slug fields,
for example `npm run work:plan -- --slug repo-harness` and
`npm run work:handoff -- --plan <path>`. The helper must refuse to overwrite,
show the target path before writing, and leave all substantive fields for the
author to complete. The templates and `docs:check` make structure consistent;
they do not generate decisions or prose by model.

## Proposed information architecture

```text
README.md                         Human product overview and local quick start
AGENTS.md                         Cross-agent entry point and hard constraints
CLAUDE.md, GEMINI.md              Small compatibility pointers to AGENTS.md
CONTRIBUTING.md                   Human contributor workflow; links into docs/development
SECURITY.md                       Disclosure route and security expectations

docs/
  development/
    README.md                     Developer documentation index and ownership/freshness table
    architecture-map.md           Package/module entry points and data-flow map
    verification.md               Verification ladder and CI/local mapping
    workflow.md                   Branch, plan, handoff, PR, release, and archive lifecycle
    release-policy.md             SemVer decisions, changelog and release-readiness rules

dev-docs/
  todo.md                         Prioritized, non-authoritative roadmap
  plans/                          Accepted/proposed implementation plans
  plans/completed/                Merged plan archive
  handoffs/active/                Short-lived, branch-scoped continuation records
  templates/                      Checked skeletons for repeatable work records
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

- [ ] Refactor the existing root `AGENTS.md` into an index plus universal
  constraints, preserving all existing fork, hook, release, version, platform,
  and harness invariants through links or scoped files. Keep `AGENTS.md` at
  the root; add compatibility pointers only after their native discovery is
  verified.
- [ ] Add `server/AGENTS.md`, `web/AGENTS.md`, and `.github/AGENTS.md` with
  only scope-specific deltas and links to their primary docs/tests.
- [ ] Add root `CLAUDE.md` and `GEMINI.md` compatibility pointers, then assess
  scoped pointers with their native tools. Add only the pointers required for
  closest-directory discovery and test that every pointer names its canonical
  sibling/root `AGENTS.md` correctly.
- [ ] Add `docs/development/README.md` and `architecture-map.md`; link them
  from `README.md`, `AGENTS.md`, and each package instruction file.
- [ ] Validate that links work when opened from their owning directory and that
  neither a human nor an agent needs to scan the full tree to find an entry
  point, persistence boundary, or test suite.

**Exit criteria:** A fresh agent can answer “where does this change belong?”
and “what do I run?” from the nearest instruction file in under five minutes.

### Phase 2 — Command hub and verification contract

- [ ] Implement the portable Node command hub and add its explicit aliases to
  the existing root `package.json`.
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
- [ ] Add `docs/development/release-policy.md`: `server/package.json` is the
  sole version, SemVer decision table, `CHANGELOG.md` versus maintenance-log
  criteria, release workflow behavior, and no-manual-tag rule.
- [ ] Add a deterministic release-readiness check for changelog structure,
  version-source consistency, and the presence of an Unreleased entry when a
  release-relevant PR declares one. It is advisory until it has survived the
  pilot; it must never tag, publish, or rewrite history.

**Exit criteria:** A contributor can make a safe PR without knowing local
folk knowledge, and policy documents have named owners/review cadence.

### Phase 4 — State coordination and handoff

- [ ] Define the active-handoff frontmatter schema (branch, plan/issue, status,
  updated ISO date) and required body headings; add examples for
  code/docs/infrastructure work and the removal rule to
  `docs/development/workflow.md`.
- [ ] Implement `handoff:check` for branch-name match, required fields, ISO
  dates, referenced-plan existence, and removal of closed handoffs from the
  active directory.
- [ ] Add a short “resume protocol” to root guidance: inspect status, recent
  commits, active handoff, plan/issue, then run the smallest relevant health
  check before changing code.
- [ ] Add a PR closing checklist that requires handoff archival/removal and
  plan/maintenance/changelog updates when applicable.
- [ ] Add templates and guarded generators for plans, handoffs, maintenance
  records, and release-readiness checks. Test missing-field, stale-date,
  mismatch, and overwrite-refusal paths.

**Exit criteria:** An agent can resume a nontrivial branch from repository
state alone, while parallel branches do not contend over one mutable file.

### Phase 5 — Documentation gardening and regression protection

- [ ] Implement `docs:check` for local links, required standard-template
  headings, manifest target/category coverage, orphaned active handoffs, and
  plan/archive placement.
- [ ] Add a CI job that runs documentation checks on every PR. The current
  test workflow already runs on documentation-only pull requests; this is a
  focused additional check, not a path-filter change or a replacement for the
  test matrix.
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
3. What duration should distinguish a quick task (no handoff) from
   cross-session work (handoff required)?
4. Which full local verification command is acceptable as the default before a
   PR, given the current backend/frontend suite duration?
