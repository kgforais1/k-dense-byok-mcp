# Office runtime retention and updates

Owner: frontend Office integration. Update this record whenever the manifest
or distribution source changes.

## Retained build

`web/src/lib/office-assets.ts` pins four files for `zeta-2025-05-13`.
The [fork release](https://github.com/kgforais1/k-dense-byok-mcp/releases/tag/v0.15.0)
retains them as `zeta-2025-05-13-<filename>`. The route uses those fixed asset
names instead of `zetaoffice_latest`, hashes every new download and checks cached
files before serving. Wrong hashes, oversized downloads and unavailable sources
return 503; no unverified download is installed. Asset administrators can still
remove or replace GitHub release assets, so retention is an operational promise;
the pinned digest remains the execution trust boundary.

The cache directory and browser build URL are unchanged. Offline provisioning
still places the four original unprefixed filenames in the documented cache.
Cold-cache downloads total approximately 250 MB; mirror transfer compression is
not assumed. The manifest now records metadata's measured size of 215,180 bytes.

## Provenance and notices

The bytes are unmodified vendor downloads. Embedded `program/versionrc` identifies
LibreOffice revision `efaf0670b4d055f838a2849becb10f08aa06a257`, verified in the
[official source mirror](https://github.com/LibreOffice/core/tree/efaf0670b4d055f838a2849becb10f08aa06a257).
Release assets include `SOURCES.txt`, `SHA256SUMS`, COPYING, COPYING.MPL,
COPYING.LGPL, NOTICE and the source revision's third-party license XML template,
all prefixed with the build name. SOURCES lists the free source download and the
vendor's Emscripten/Qt source references. Toolchain links are vendor references,
not independently recovered toolchain commit IDs. The full conditional license
template includes notices for optional components without asserting they are all
present in this build. Existing binary bytes and notices remain intact.

## Publication and update procedure

1. Collect the exact tested vendor files in a disposable directory; compute every
   SHA-256 and measured size against the reviewed manifest. Never upload user
   documents, application caches beyond these four files, or credentials.
2. Retain the embedded build ID, corresponding source URL, licensing and third-party
   notices with the publication. Keep those source references available.
3. Use an existing automation-created fork release; create no manual version tag.
   Name assets `<new-build>-<filename>`. Upload with `gh release upload <tag>
   <explicit-bundle-files> --repo kgforais1/k-dense-byok-mcp`, without `--clobber`.
   Never overwrite old names with different bytes or delete retained old builds.
4. Download the published files independently into an empty cache and verify every
   digest. Exercise the actual asset route, not just a release asset listing.
5. For a new runtime, update build ID, source URL, hashes, measured sizes and the
   browser runtime path together. Repeat Writer/Calc/Impress keyboard/save checks;
   do not infer editing correctness from export alone.
6. Run route corruption/cold-cache tests, frontend verification and docs checks.
   Record evidence in the maintenance log and close TODO/plan in the implementing PR.

## Regression verification

`cd web && npm test -- --run src/lib/office-assets-route.test.ts` exercises small,
offline fixtures against the actual route: retained cold-cache fetch, offline cache
reuse, corrupt download rejection with retry, corrupt-cache recovery, oversize and
missing mirror failures, and unknown path/build rejection. Real release byte checks
are separate because unit tests must not download hundreds of megabytes.
