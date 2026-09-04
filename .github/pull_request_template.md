<!--
PR template for kgforais1/k-dense-byok-mcp.
All five evidence sections are mandatory — reviewers reject PRs that omit them.
Delete the HTML comments and fill each section; do not delete a heading.
See CONTRIBUTING.md and docs/development/workflow.md for the full lifecycle.
-->

## Scope

<!-- What changed and what explicitly did not. Name the package/area boundary
     (server / web / .github / docs / harness) and link the accepted plan
     or issue if applicable. Example:
     - Server: `server/src/provenance/scanner.ts` — bounded scan budget.
     - Explicitly out of scope: no API route change, no web change. -->

- Area(s):
- Out of scope:
- Plan / Issue:

## Commands / Tests run with evidence

<!-- Paste the exact commands, their exit codes, and the relevant output or
     links. The verification ladder is in docs/development/verification.md;
     the hub is scripts/repo.mjs. Examples:
     - `npm run verify -- fast` — exit 0, 3/3 ok.
     - `npm run verify -- server` — exit 0, 70 suites / 604 tests.
     - CI run: link to the workflow run on this PR's branch.
     Commands are quoted verbatim so reviewers can reproduce them. -->

- [ ] `npm run verify -- fast` — 
- [ ] `npm run verify -- server` — 
- [ ] `npm run verify -- web` — 
- [ ] `npm run verify -- docs` — 
- [ ] `npm run verify -- all` — 
- [ ] Other (with output):
- CI:

## Docs touched

<!-- Every canonical doc reviewed or updated and the ownership/freshness row it
     maps to (docs/development/README.md), or "None — no doc surface changed"
     with a one-line justification. If you updated a manifest-listed entry point,
     name the manifest entry you updated. -->

- [ ] `AGENTS.md` / scoped `AGENTS.md` —
- [ ] `docs/development/...` —
- [ ] `docs/...` (product docs) —
- [ ] `scripts/repo-manifest.json` — entry `<id>` / no change
- [ ] `CHANGELOG.md` — `Unreleased` / no user-facing change
- [ ] `dev-docs/maintenance-log.md` — entry / not applicable
- Result: None — no doc surface changed / docs updated as above

## Security / Privacy impact

<!-- Secrets, sandbox egress, auth store, provenance, or provider credential
     handling. Name the origin of any imported code/skills/templates, or
     "None" with a one-line justification. Examples:
     - None — markdown-only docs change, no code or secret surface.
     - Server: adds `fetch` to `sandbox.ts`; egress is project-scoped; no secret logged.
     Consult SECURITY.md and docs/limitations.md#local-shell-trust-boundary. -->

- Impact: None / describe
- Imported code / skill origin: None / source + pin + review note

## Handoff disposition

<!-- Branch-scoped coordination state for work that crossed a session/agent
     boundary. One of:
     - None — single-session change, no handoff.
     - Active: `dev-docs/handoffs/active/<branch>.md` (link; must have frontmatter branch/plan/status/updated and required headings).
     - Archived / removed: `dev-docs/handoffs/active/<branch>.md` → removed on merge; enduring decisions distilled to `dev-docs/maintenance-log.md#YYYY-MM-DD`.
     Gate: `npm run handoff:check` must pass. See docs/development/workflow.md. -->

- Disposition: None / Active: `dev-docs/handoffs/active/...` / Archived/removed
- Linked plan: `dev-docs/plans/YYYY-MM-DD-....md` / None
- `npm run handoff:check`: pass / fail — 

---

### PR closing checklist

<!-- Complete before requesting review. Check each item or mark N/A with a reason. -->

- [ ] Handoff archived or removed from `dev-docs/handoffs/active/` when the work merges/is abandoned/is superseded (or N/A — no handoff)
- [ ] Plan updated to `Completed and merged in PR #...` and moved to `dev-docs/plans/completed/` when the implementing PR merges (or N/A)
- [ ] `CHANGELOG.md` `Unreleased` updated when shipped behavior changed (or N/A)
- [ ] `dev-docs/maintenance-log.md` appended when security/dependency/CI/operational work applies (or N/A)
- [ ] Enduring incident or operational decision distilled from the handoff into the maintenance log instead of retaining a second state record (or N/A)

<!--
Fork policy reminder:
- PR target must be kgforais1/k-dense-byok-mcp (not upstream).
  Use: gh pr create --repo kgforais1/k-dense-byok-mcp
- Never use git push --no-verify; the pre-push hook blocks non-fork pushes.
-->
