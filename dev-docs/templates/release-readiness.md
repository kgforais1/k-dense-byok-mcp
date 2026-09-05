# Release Readiness Checklist

- [ ] Single version source in `server/package.json` bumped appropriately per SemVer.
- [ ] `CHANGELOG.md` has entries moved from `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD`.
- [ ] Keep-a-Changelog categories used (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`).
- [ ] Local verification ladder passes (`npm run verify -- all`).
- [ ] No uncommitted files or branch-dirty state.
- [ ] PR created targeting fork `kgforais1/k-dense-byok-mcp`.
