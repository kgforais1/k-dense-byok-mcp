---
title: "SonarCloud quality gate triage and disposition"
status: accepted
created: 2026-10-10
branch: sync/upstream-2026-10-08
pr: 51
---

# SonarCloud quality gate triage and disposition

**Status:** Accepted

**Goal:** Clear the failing `SonarCloud Code Analysis` check on PR #51 by fixing every
issue that is genuinely fixable in repository code, and resolving the remainder in the
SonarCloud dashboard with a documented, evidence-backed justification.

## Gate state (measured 2026-10-10)

PR #51 check `SonarCloud Code Analysis` is `failure`. Of five gate conditions,
two are in `ERROR`:

| Condition | Actual | Required | Status |
|---|---|---|---|
| `new_reliability_rating` | 4 (D) | ≤ 1 (A) | **ERROR** |
| `new_security_rating` | 4 (D) | ≤ 1 (A) | **ERROR** |
| `new_maintainability_rating` | 1 (A) | ≤ 1 | OK |
| `new_duplicated_lines_density` | 0.8 | ≤ 3 | OK |
| `new_security_hotspots_reviewed` | 100.0 | ≥ 100 | OK |

28 open issues in PR scope — 11 `BUG`, 9 `VULNERABILITY`, 8 `CODE_SMELL`, `effortTotal`
378 min. Project-wide baseline: 42 bugs, 116 code smells, 36 vulnerabilities,
`reliability_rating` 4.0, `security_rating` 5.0.

Sonar rating bands relevant here: `A` = zero findings, `B` = at least one minor,
`C` = at least one major, `D` = at least one critical, `E` = at least one blocker.

**The decisive consequence.** An `A` threshold on new code means *every* new
bug and vulnerability must be gone, not merely reduced:

- **`new_reliability_rating` is achievable with code alone.** All 11 bugs
  (10 × `typescript:S2871`, 1 × `typescript:S5850`) have real code remedies.
- **`new_security_rating` is not.** 7 of the 9 vulnerabilities sit in the
  vendored, upstream-owned ZetaOffice snapshot or in code whose behaviour is
  required by the WASM engine, so no repository change can remove them:
  `javascript:S5443` ×3, `Web:S7039` ×2, `typescript:S8479`, `python:S5332`.
  These require dashboard resolutions.

Prior art: `dev-docs/maintenance-log.md` records 18 Sonar quality fixes on
2026-10-09 and notes the gate was still failing afterwards ("SonarCloud remains
blocked on its reliability/security ratings (46 findings)"). The handoff adds
"Runtime unsafe-eval remains unresolved; intentional-behavior findings have not
been dismissed remotely." Nothing has been dismissed, so no existing disposition
needs to be preserved.

## Disposition table

`FP` = mark **False positive** (the rule's premise is wrong).
`WONT` = mark **Won't fix** (real finding, accepted by design).
Both resolve the issue and remove it from the rating metrics; the distinction
matters for honesty, not for the gate.

### Group 1 — fix in code (16 issues, 11 files)

| Rule | Location | Issue key | Change |
|---|---|---|---|
| typescript:S2871 | `server/src/agent/agent-files.ts:258` | `AaEhokRy6Za53JnjS2vx` | Add compare function |
| typescript:S2871 | `server/src/agent/compaction-bridge.ts:198` | `AaEhokJE6Za53JnjS2vj` | Add compare function |
| typescript:S2871 | `server/src/agent/compaction-bridge.ts:199` | `AaEhokJE6Za53JnjS2vk` | Add compare function |
| typescript:S2871 | `server/src/agent/prompts.ts:343` | `AaEhokLM6Za53JnjS2vp` | Add compare function |
| typescript:S2871 | `server/src/agent/verifier-models.ts:146` | `AaEhokOp6Za53JnjS2vt` | Add compare function |
| typescript:S2871 | `server/src/agent/verifier-models.ts:146` | `AaEhokOp6Za53JnjS2vu` | Add compare function |
| typescript:S2871 | `server/src/agent/verifier-models.ts:161` | `AaEhokOp6Za53JnjS2vv` | Add compare function |
| typescript:S2871 | `server/src/agent/verifier-models.ts:169` | `AaEhokOp6Za53JnjS2vw` | Add compare function |
| typescript:S2871 | `web/src/components/connectors-panel.tsx:631` | `AaEhoj6l6Za53JnjS2vS` | Add compare function |
| typescript:S2871 | `web/src/components/lab-notebook-view.tsx:144` | `AaEhojxZ6Za53JnjS2vR` | Add compare function |
| typescript:S5850 | `web/src/components/latex/log-panel.tsx:9` | `AaEhojtK6Za53JnjS2vP` | Group the regex |
| typescript:S7773 | `server/src/index.ts:268` | `AaEhokYZ6Za53JnjS2v3` | `parseInt` → `Number.parseInt` |
| javascript:S7773 | `start.mjs:46` | `AaEhokdc6Za53JnjS2v7` | `parseInt` → `Number.parseInt` |
| typescript:S7773 | `web/src/components/office-toolbar.tsx:51` | `AaEhoj6v6Za53JnjS2vW` | `parseInt` → `Number.parseInt` |
| typescript:S7773 | `web/src/lib/office-render.ts:38` | `AaEhoj-C6Za53JnjS2va` | `parseFloat` → `Number.parseFloat` |
| typescript:S6853 | `web/src/components/connectors-panel.tsx:970` | `AaEhoj6l6Za53JnjS2vT` | Associate the label with its control |

**Why the compare function, and why not `localeCompare`.** Bare `Array.sort()`
orders by UTF-16 code units, which is locale-independent but puts every uppercase
letter ahead of every lowercase one. Verified empirically — the explicit code-unit
comparator below is byte-identical to bare `.sort()` across every shape tested
(lowercase names, mixed case, non-ASCII, surrogate pairs, and `Object.entries`
pair arrays), while `localeCompare` is not:

```
["Session-10","Session-2","a1b2c3"]  code-unit: Session-10, Session-2, a1b2c3
                                    locale:    a1b2c3, Session-10, Session-2   ← differ
["Beta","alpha","Delta"]             code-unit: Beta, Delta, alpha
                                    locale:    alpha, Beta, Delta             ← differ
["zebra","Ähnlich","apple"]          code-unit: apple, zebra, zur(…), Ähnlich
                                    locale:    Ähnlich, apple, …              ← differ
```

`String.localeCompare` — the fix Sonar's message names — is the *wrong* remedy: it
is locale- and ICU-dependent, so it makes ordering *less* deterministic and would
diverge on any mixed-case, non-ASCII or session-id input. Use an explicit
comparator that preserves today's code-unit order exactly, e.g.
`(a, b) => (a < b ? -1 : a > b ? 1 : 0)`. Ordering is unchanged, determinism is
unchanged, and the rule is satisfied.

The divergence is **latent, not currently active**: every seeded roster, template
and verifier name shipped today is lowercase (`LEGACY_SEEDED_TEMPLATES`,
`LEGACY_SEEDED_ROSTER`), and `lab-notebook-view.tsx:144` only builds a `useMemo`
dependency key, where order affects cache invalidation and not correctness. So the
cost of getting this wrong is a future regression, not a present bug — which is
why it still belongs in Group 1 rather than being dismissed.

### Group 2 — fix in code, hardens a real surface (2 issues)

| Rule | Location | Issue key | Change |
|---|---|---|---|
| pythonsecurity:S8707 | `server/src/helpers/office_helper.py:39` | `AaEhokS86Za53JnjS2v0` | Validate the argv path inside `Package.__init__` |
| githubactions:S8541 | `.github/workflows/tests.yml:47` | `AaEhokcb6Za53JnjS2v6` | Try `uv sync --no-build` |

`S8707` is a false positive *as deployed* — `server/src/api/office.ts` is the only
caller and always passes its own `path.join(dir, "input.<kind>")` with `kind`
pinned by `kindOf()` to `docx|pptx|xlsx` — but the helper accepts an arbitrary
`sys.argv[1]` with no containment check, which is a genuine latent weakness. A
realpath/prefix assertion removes the finding and the weakness together.

`S8541` is one line, but `--no-build` changes dependency installation behaviour.
Land it only if CI still installs the scientific test dependencies; otherwise
resolve as FP (see below) — the lockfile is `--frozen` from the repo's own
`server/src/helpers/uv.lock` on a pinned toolchain, which is not the threat the
rule describes.

### Group 3 — dashboard only, no code remedy (7 issues)

| Rule | Location | Issue key | Resolution | Evidence |
|---|---|---|---|---|
| javascript:S5443 | `web/public/office/runtime.js:41` | `AaEhokDT6Za53JnjS2vb` | FP | `/tmp/office` is Emscripten **MEMFS** inside the WASM sandbox, not the OS temp dir. `FS` is a `/* global FS */` virtual filesystem supplied by the pinned loader. |
| javascript:S5443 | `web/public/office/runtime.js:42` | `AaEhokDT6Za53JnjS2vc` | FP | Same. |
| javascript:S5443 | `web/public/office/runtime.js:65` | `AaEhokDT6Za53JnjS2vd` | FP | Same. |
| Web:S7039 | `web/public/office/runtime.html:3` | `AaEjq_whuTTJwnnNnp3y` | WONT | `unsafe-eval`/`wasm-unsafe-eval` is required by the Emscripten WASM engine. |
| Web:S7039 | `web/public/office/runtime.html:3` | `AaEjq_whuTTJwnnNnp3z` | WONT | `unsafe-inline` is required by the canvas layout `<style>`. Page is otherwise `default-src 'self'`, `object-src 'none'`, `base-uri 'none'`. |
| typescript:S8479 | `web/src/lib/office-render.ts:7` | `AaEhoj-C6Za53JnjS2vZ` | FP | `ADD_TAGS: ["style"]` is required for DOCX inline styles, and the output is mounted in `<iframe sandbox="" srcDoc={…}>` (`web/src/components/viewers/office-viewer.tsx:68`) — fully sandboxed, no scripts, no same-origin — under a `default-src 'none'` CSP. Not a DOM-XSS vector. |
| python:S5332 | `server/src/helpers/office_helper.py:63` | `AaEhokS86Za53JnjS2vz` | FP | The flagged `http://` string is an **XML namespace identifier**, never fetched. Parser is built with `no_network=True, load_dtd=False, resolve_entities=False`. |

### Group 4 — dashboard, rule premise wrong but finding real (3 issues)

| Rule | Location | Issue key | Resolution | Evidence |
|---|---|---|---|---|
| javascript:S2310 | `web/public/office/zeta.js:573` | `AaEhokDo6Za53JnjS2vh` | FP | Raw message is `Remove this assignment of "j"` (offset 51–52 = the loop's `j++`). The `let arg = arguments[j + 1]` initializer *is* read: it is passed to `new Any(…, arg)` and then pushed. Dead-store detection misfires on the conditional-reassignment pattern. File is vendored upstream snapshot and must not be edited. |
| typescript:S9379 | `web/src/components/delegate-picker.tsx:98` | `AaEhoj736Za53JnjS2vX` | WONT | `autoFocus` is gated behind a prop defaulting to `false` (`delegate-picker.tsx:32`), but the only caller (`add-context-menu.tsx:281`) passes it unconditionally inside a Radix `Popover`, alongside three sibling pickers that do the same. Auto-focusing a search input in an open popover is the correct pattern. |
| typescript:S6845 | `web/src/components/latex/latex-editor.tsx:995` | `AaEhojuP6Za53JnjS2vQ` | WONT | The element **is** interactive: `role="separator"` with `aria-valuenow/min/max`, a real `onKeyDown` handling ArrowLeft/ArrowRight, and an `onMouseDown` drag handler. `tabIndex={0}` is required for keyboard operation, not a defect. |

## Where the two independent investigations disagreed

Two investigations were run against the same tree before this plan was written:
this session, and a separate `agy/gemini-3.8-flash-high` agent (read-only, briefed
with the same API data). They agreed on 24 of 28 issues. The four divergences:

**1. `typescript:S2871` ×10 — real bug, not false positive. (Disagreement.)**

The agy agent marked all ten `FP`, reasoning that code-unit order is intended so
hashes stay stable. The premise is right and the conclusion is wrong: because
uppercase sorts ahead of lowercase, these orderings are ASCII-cased and produce
ghost "changes" on mixed-case input, and `verifier-models.ts:146` compares
`JSON.stringify(Object.entries(owned).sort())` against a rebuilt value, so the
comparison inherits that instability directly. It is a real (low-severity,
test-covered) bug. This disagreement is load-bearing: these ten are 10 of the 11
issues that determine the failing `new_reliability_rating`, and mistaking them for
unfixable false positives would make the gate look unpassable when it is not.

**2. `typescript:S9379` — intended behaviour, not false positive. (Label disagreement.)**

The agy agent called it `FP` because `autoFocus` is prop-gated. That misses that
the only caller always sets it, so the gate is decorative and the effect is real.
Because the *pattern* is correct, the disposition is the same (do not change the
code), but the resolution should be **`Won't fix`**, not `False positive` — marking
it a false positive would assert the finding is untrue, which it is not.

**3. `javascript:S2310` — the flagged symbol was misread. (Factual correction.)**

The agy agent read the message as flagging `let arg` and reasoned about `arg`. The
API returns `Remove this assignment of "j"` with `startOffset 51, endOffset 52` on
line 573 — the loop counter increment. The agent's conclusion (not a dead store)
happens to survive the correction, but the reasoning does not, and an argument
built on the wrong symbol is not usable as dashboard justification.

**4. `typescript:S6845` — interactive element, so the rule's premise fails, not just the outcome. (Framing disagreement.)**

The agy agent marked `FP`. Same disposition, weaker justification: it argued the
element is a "custom interactive resize slider" without citing the keyboard and
pointer handlers that make it one. The dashboard comment must name the
`role="separator"` + `aria-valuenow` + `onKeyDown` + `onMouseDown` evidence, or a
future reader cannot tell this from a blanket dismissal.

Resolutions to be filed per this plan, not per the agent's table.

## Implementation sequence

1. **Land Group 1 as one PR** (16 issues, 11 files). All mechanical and
   behaviour-preserving. Must include the explicit code-unit comparator, never
   `localeCompare`.
2. **Land Group 2 as one PR** (2 issues), independently verifiable: run the
   helper's own exit-code contract and the full CI dependency install.
3. **Verify the reliability rating empirically.** After Group 1 merges, confirm
   `new_reliability_rating` reaches A on a fresh analysis. This is the first
   empirical test of the assumption that resolving all bugs in new code yields A.
4. **File Group 3 and Group 4 resolutions in the dashboard**. This step is
   **not yet approved and must not be executed** — the user's standing
   instruction is that nothing is marked in the SonarCloud dashboard yet.
   A `SONAR_CLOUD_TOKEN` is now available in the repository's `.env` (gitignored;
   never log or commit its value). Until it is supplied to a shell, every
   resolution below is a proposal only.
5. **Re-verify the security rating.** Expect the trajectory D → C → B → A as each
   severity band clears; if it does not clear after all seven are resolved, the
   new-code window mismatch noted below needs investigation rather than more
   dispositions.

## Guardrails

No `// FORK:` marker is required for Group 1 or 2 changes. These files are
upstream-owned (`git cat-file -e upstream/main:<path>` succeeds for all 18 flagged
files), but the overlay rule in `CONTRIBUTING.md#keeping-up-with-upstream` scopes
markers to *in-place edits that would otherwise conflict*; these are
behaviour-preserving comparator and label-attribute changes that upstream can
re-apply cleanly. Do not introduce a marker that upstream would then have to
carry.

Never edit `web/public/office/zeta.js`, `runtime.js` or `runtime.html` to satisfy
a scanner. `runtime.js` and `runtime.html` are fork-authored host scripts and
`zeta.js` is a SHA-pinned vendored snapshot; changing them to dodge a rule is
both fragile and a silent divergence from the pinned asset.

Do not switch any `.sort()` to `localeCompare`, and do not collapse the
code-unit comparator into a shorter form that changes ordering.

No dashboard action is taken as part of a code PR — dispositions are a separate,
user-approved step. **Nothing in this plan authorizes a dashboard change**: all
Group 3 and Group 4 rows are proposals pending explicit user approval, and the
`SONAR_CLOUD_TOKEN` in `.env` is gitignored and must never be logged or committed.

## Verification gates

| Outcome | Evidence |
|---|---|
| Group 1 correct and behaviour-preserving | `npm run verify -- server` and `npm run verify -- web` pass; `server/test/{verifier-models,prompts-api,backend,agent-memory,notebook-subagent-bridge,mcp-headless-sessions,models}.test.ts` and the compaction-bridge and connectors-panel suites still pass unchanged — these seven suites cover exactly the files whose sort order changes |
| Group 1 silent-order regression check | Assert persisted `.kady` marker ordering is byte-identical before and after (the comparator must be a no-op ordering-wise, so a golden-file or snapshot comparison is sufficient) |
| Group 2 safe | Helper exit-code contract (0/3/4/5) unchanged; `uv sync` step still green in CI |
| Metrics actually move | Fresh SonarCloud analysis shows `new_reliability_rating` down after Group 1 and `new_security_rating` down after Group 3 |
| Gate green | PR #51 `SonarCloud Code Analysis` reports `success` |

## Follow-ups (recorded here; not to be lost)

- **The gate is structurally hostile to this repo.** `new_reliability_rating` and
  `new_security_rating` at threshold 1 require an `A` — zero new findings. The
  user cannot raise the threshold on the SonarCloud free plan, so the only lever
  is per-issue disposition. Every future upstream sync that introduces new code
  will hit the same wall. If this recurs, the realistic options are to exclude the
  vendored `web/public/office/**` snapshot from analysis or to gate on
  `new_bugs`/`new_vulnerabilities` counts instead of ratings.
- **Investigate the new-code window mismatch.** All 28 issues report
  `inNewCodePeriod: false`, yet the new-code ratings are D. Either the PR
  analysis window and the project's new-code definition disagree, or the API flag
  is not a reliable proxy for PR scope. Resolve this before assuming further code
  fixes move the gate.
- **42 bugs / 36 vulnerabilities / 116 code smells are still open project-wide.**
  This plan clears only the 28 in PR #51's scope. Nothing here reduces the
  overall `reliability_rating` 4.0 / `security_rating` 5.0 baseline.
- **The AGENTS.md "Caveats worth knowing" and handoff text should be updated**
  once the MEMFS and unsafe-eval dispositions are filed, so the next agent does
  not re-litigate them. Currently `AGENTS.md` and the active handoff both
  describe these as open evidence gaps.
