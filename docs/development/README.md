# Developer Documentation

This index is the entry point for contributor/developer documentation. It
is distinct from the product-facing docs under `../` (which describe
features as users see them) and from the agent-harness instructions at
[`../../AGENTS.md`](../../AGENTS.md) (which govern humans and coding
agents editing this repository). The agent harness points here; product
docs do not.

## How to use this index

1. Start with the **architecture map** to find the package, module, or
   data flow relevant to a change.
2. Move to the **verification ladder** before running any check; it tells
   you which command to run, in which directory, and what success looks
   like.
3. Use the **workflow** doc for branch, plan, handoff, PR, and release
   lifecycle, and the **release policy** for SemVer, changelog, and
   release-readiness rules.
4. Update the entry in the **ownership/freshness table** that matches
   the area you are changing; the doc there names the audience and the
   update triggers.

## Documents in this index

| Document | Purpose | Audience |
|---|---|---|
| [`architecture-map.md`](architecture-map.md) | Package/module entry points and data-flow map. | Contributors and coding agents choosing where a change belongs. |
| [`verification.md`](verification.md) | Fast targeted checks, package checks, full local checks, CI matrix coverage, expected runtime. | Contributors picking a command; release engineers. |
| [`workflow.md`](workflow.md) | Branch, plan, handoff, PR, release, and archive lifecycle. | Anyone working in a feature branch or handing work off. |
| [`release-policy.md`](release-policy.md) | SemVer decisions, changelog rules, release-readiness checks, no-manual-tag rule. | Release captains and contributors touching public contracts. |

Out of scope here: product docs (under `../`), agent-harness policy
(`../../AGENTS.md` and scoped `AGENTS.md`), and runtime Pi-agent policy
under each project sandbox (`projects/<id>/sandbox/.pi/`).

## Category definitions

`repo-manifest.json` and `docs:check` read categories from this
list. Each manifest entry is required to belong to one of them; the
author who adds, removes, or relocates a manifest-listed entry point
updates the manifest in the same PR.

| Category | Definition | Example |
|---|---|---|
| `entry-point` | Process entry point: boots a service, runner, or top-level command. | `start.mjs`, `server/src/index.ts`, `web/src/app`. |
| `runtime-service` | A long-lived service module: route registration, agent wiring, or background work. | `server/src/agent/models.ts`, `server/src/modal/manager.ts`. |
| `persistence-boundary` | An on-disk state location or writer under `projects/<id>/` or `.kady/`. | `server/src/cost/ledger.ts`, `server/src/provenance/recorder.ts`. |
| `policy` | A document or script that defines rules an agent or human must follow. | `AGENTS.md`, `server/AGENTS.md`, `.githooks/pre-push`. |
| `verification` | A file that defines or runs a verification check or test suite. | `.github/workflows/tests.yml`, `scripts/repo.mjs`, `server/vitest.config.ts`. |
| `developer-documentation` | A canonical contributor/developer document under `docs/development/` or `dev-docs/`. | `docs/development/README.md`, `dev-docs/maintenance-log.md`. |
| `product-documentation` | A product-facing document under `docs/` that describes a feature to users. | `docs/architecture.md`, `docs/file-previews.md`. |
| `release-record` | A file that records or governs releases, versions, or dependencies. | `CHANGELOG.md`, `server/package.json`, `.github/dependabot.yml`. |

Categories are about navigation, not code ownership. A module can be
discoverable from more than one category; pick the one that is most
useful when an agent is trying to find where a change belongs.

## Ownership and freshness

The following table names the area, audience, and update triggers for
each canonical document. Reviewers should consult the "update triggers"
column when reviewing a PR; contributors should consult it before
opening one. When a row's owner or trigger changes, edit the row in the
same PR that changes the underlying doc — this table is the single
place reviewers go to learn what a doc covers.

| Document | Owner area | Audience | Update triggers | Source of truth |
|---|---|---|---|---|
| `../../AGENTS.md` | Cross-agent policy | Humans and coding agents | Fork, hook, release, version, platform, or harness invariant changes | Code + merged CI. |
| `server/AGENTS.md` | Backend | Backend contributors | Pi SDK version bump, route or store addition, helper-venv change, new tool family | `server/src/` and `server/test/`. |
| `web/AGENTS.md` | Frontend | Frontend contributors | Next.js/React version bump, viewer-registry change, capability-hub structure change | `web/src/` and `next.config.ts`. |
| `.github/AGENTS.md` | Automation & release | Workflow authors and release captains | Matrix change, permission change, action-pinning policy change, release flow change | `.github/workflows/` and `release.yml`. |
| [`architecture-map.md`](architecture-map.md) | Cross-cutting | Contributors orienting in the codebase | New package, new entry point, new data flow | Manifest and code; both win on disagreement. |
| [`verification.md`](verification.md) | Cross-cutting | Contributors picking a command | Command, runner, or matrix change | `package.json` files and `.github/workflows/tests.yml`. |
| [`workflow.md`](workflow.md) | Cross-cutting | Branch authors and reviewers | Branching, plan/handoff template, PR template change | `dev-docs/`, root templates. |
| [`release-policy.md`](release-policy.md) | Release | Release captains and contributors touching public contracts | SemVer decision, changelog rule, release-readiness change | `server/package.json`, `CHANGELOG.md`, `.github/workflows/release.yml`. |
| `../architecture.md` | Product (architecture) | Users and integrators | Runtime architecture changes (new tool family, new store, new provider) | Code; this doc is product-facing, not contributor-facing. |
| `../file-previews.md` | Product (file previews) | Users | New viewer added to the registry | `web/src/lib/viewers/registry.ts`. |
| `../limitations.md` | Product (limitations) | Users and integrators | Provider refusal, trust boundary, harness pin change | Code and tests; the limitations page is short and explicit. |

## Freshness rules

- A doc is considered **stale** if a code or CI change in its source of
  truth is not reflected in the doc. The author of the change updates
  the doc in the same PR; reviewers reject PRs that introduce a
  staleness without flagging it.
- The scheduled, report-only audit (planned; not yet implemented) opens a
  labeled maintenance issue when a doc's source-of-truth changes are not
  matched in the doc; it never edits the doc or closes the issue on partial
  failures.
- `docs:check` catches **structural** drift: broken local
  links, missing required headings, manifest target/category coverage,
  orphaned active handoffs, and plan/archive placement. It does not
  catch semantic drift; that is the reviewer's job.

## Adding a new document

1. Pick the smallest category from the table above that fits.
2. Add a row to the **ownership/freshness table** above (or to the
   scope-specific scoped `AGENTS.md`) in the same PR.
3. Add a manifest entry under `scripts/repo-manifest.json` if the doc
   is one a coding agent should be able to discover from the command
   hub. The author of a new manifest entry updates both files in the
   same PR.
4. Do not add a document that duplicates a rule already in any
   `AGENTS.md` file; link instead.
