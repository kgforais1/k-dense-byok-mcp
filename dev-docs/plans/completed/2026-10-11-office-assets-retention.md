---
title: "Immutable Office runtime retention"
status: completed
created: 2026-10-11
branch: office-assets-retention
---

# Immutable Office runtime retention

**Status:** Completed and merged in PR #55

**Goal:** Resolve #52 by keeping the exact tested Office runtime available to
cold-cache installations without weakening its pinned SHA-256 checks.

## Why this work

The route currently fetches `zetaoffice_latest`, a moving vendor CDN path.
Hash mismatch correctly fails with 503, but a changed CDN build would strand
new installations. Keyboard edit/save is now verified for the existing pins.

## Design decisions

- Prefer a fork-owned, versioned release mirror of the four tested files.
  Do not substitute a third-party mirror or silently upgrade the runtime.
- Keep the manifest allowlist, SHA-256 checks, build-specific cache and atomic
  installation. A mirror is an availability source, never a trust bypass.
- Retain vendor attribution and source/license information with distributed
  binaries. Verify the relevant source revisions and notices before publishing.
- The vendor's official `examples/web-office/config.sample.js` ([source](https://github.com/allotropia/zetajs/blob/main/examples/web-office/config.sample.js)) supports hosting
  the four runtime files at a custom base URL. No immutable vendor URL has yet
  been established; the CDN root returns 404.

## Proposed information architecture / file changes

- `web/src/lib/office-assets.ts`: explicit versioned source manifest.
- Office asset route/helper: fetch the retained build, keeping verification.
- Offline route tests: cold-cache success, corruption rejection, retry and cache.
- Retention tooling/documentation: verified publication inputs, source notices,
  update procedure and cold-cache check against published bytes.

## Implementation sequence

### Phase 1 — Retention provenance

- Verify the four cached files against the committed manifest.
- Establish exact vendor source/redistribution notices and a versioned fork
  release destination; prepare a concrete publication bundle before upload.

**Exit criteria:** All bytes match pins; source and notices accompany the bundle.

### Phase 2 — Fetch and regression coverage

- Switch cold-cache downloads to the retained versioned build.
- Test small offline fixtures for success and hash/size rejection; retain 503.
- Verify published assets independently and perform a real cold-cache open.

**Exit criteria:** Moving vendor latest is no longer required; corruption cannot serve.

### Phase 3 — Closeout

- Run frontend verification and docs/fast gates; record results and update docs.
- Remove #52 TODO only when the mirror is published and the implementation ships.
- Archive this plan in the implementing PR's closing checklist.

## Guardrails

No binary blobs in Git history, no source changes to unrelated providers or
Office editing, no upstream pushes, no verification bypasses. Release names must
identify the pinned build; never overwrite a retained asset with different bytes.

## Acceptance measures

| Outcome | Evidence |
| --- | --- |
| Exact tested runtime retained | Published files independently match all four SHA-256 pins |
| Cold cache works | Fresh cache opens using retained build with vendor latest unavailable |
| Integrity remains enforced | Offline mismatch/oversize tests return failure without installing bytes |
| Maintenance is repeatable | Documented provenance, publication and update procedure |

## Completion evidence

Published all four tested assets with build-prefixed names and source/license
notices on the existing fork v0.15.0 release. An actual-route cold-cache download
independently verified every SHA-256 and measured size. Five offline route tests
pass; full verification passes 1,928 backend tests (8 intentional skips), 938
frontend tests, both typechecks and docs gates. All PR CI checks passed at
`b87026b`. OpenCode Go DeepSeek V4.1 Flash approves both the docs and implementation
commits with no blocking defects. Its non-blocking closeout reminder is resolved
by this plan archival and deletion of the shipped TODO in PR #55.
