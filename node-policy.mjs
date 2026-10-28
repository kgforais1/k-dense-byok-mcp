/**
 * Kady Node runtime policy — zero-dependency version predicate.
 *
 * Decides whether the running Node ships a bundled undici new enough to
 * contain the GHSA-xjj6-f33q-929c fix. Supported stable release ranges:
 *
 *   22.23.4 <= v < 23
 *   24.22.1 <= v < 25
 *   26.12.1 <= v < 27
 *
 * Everything else is rejected: earlier patch lines (affected bundled
 * copies), odd majors (23, 25 — no LTS line Kady verifies), future majors
 * (27+ — fix and Pi/Next.js compatibility unverified), prereleases, and
 * malformed input. Failing closed is deliberate: an unknown runtime must
 * never be treated as safe.
 *
 * Constraints (this file runs before anything else at startup):
 * - No imports, no external packages, no Node-version-sensitive syntax.
 *   Only `process.version`-style strings in, plain data out.
 * - Side-effect free: importing this module changes nothing. Callers
 *   (launcher, service preload) decide what to do with the verdict.
 */

export const SUPPORTED_NODE_RANGES = [
  { major: 22, minMinor: 23, minPatch: 4 },
  { major: 24, minMinor: 22, minPatch: 1 },
  { major: 26, minMinor: 12, minPatch: 1 },
];

/** Human-readable form of the supported ranges, for messages and docs. */
export const SUPPORTED_NODE_DESCRIBE =
  "22.23.4 <= 22.x < 23, 24.22.1 <= 24.x < 25, 26.12.1 <= 26.x < 27 (stable releases only, no prereleases)";

function isDigits(text) {
  return /^[0-9]+$/.test(text);
}

/**
 * Strict SemVer numeric identifier: digits only, no leading zeros
 * ("04" is not valid SemVer; Node never emits it, so reject fail-closed).
 */
function isValidNumericId(text) {
  if (!isDigits(text)) return false;
  return text === "0" || text.charAt(0) !== "0";
}

/** SemVer prerelease/build identifier charset: ASCII alphanumerics + hyphen. */
function isValidTagId(text) {
  return text.length > 0 && /^[0-9A-Za-z-]+$/.test(text);
}

function isValidPrerelease(text) {
  if (text.length === 0) return false;
  var parts = text.split(".");
  for (var i = 0; i < parts.length; i++) {
    if (!isValidTagId(parts[i])) return false;
    // Numeric prerelease identifiers must not have leading zeros (SemVer 9).
    if (isDigits(parts[i]) && parts[i] !== "0" && parts[i].charAt(0) === "0") return false;
  }
  return true;
}

function isValidBuild(text) {
  if (text.length === 0) return false;
  var parts = text.split(".");
  for (var i = 0; i < parts.length; i++) {
    // Leading zeros ARE allowed in build metadata (SemVer 10).
    if (!isValidTagId(parts[i])) return false;
  }
  return true;
}

/**
 * Parse a Node version string into its parts.
 * Accepts an optional leading "v" and surrounding whitespace (the shape of
 * `process.version`), plus valid SemVer build metadata ("+...").
 * Returns null for anything malformed (including any prerelease marker that
 * is itself invalid — callers must not treat garbage as a version).
 */
export function parseNodeVersion(input) {
  if (typeof input !== "string") return null;
  var text = input.trim();
  if (text.length === 0) return null;
  if (text.charAt(0) === "v" || text.charAt(0) === "V") text = text.slice(1);
  if (text.length === 0) return null;

  var build = null;
  var plus = text.indexOf("+");
  if (plus !== -1) {
    build = text.slice(plus + 1);
    text = text.slice(0, plus);
    if (!isValidBuild(build)) return null;
  }

  var prerelease = null;
  var dash = text.indexOf("-");
  if (dash !== -1) {
    prerelease = text.slice(dash + 1);
    text = text.slice(0, dash);
    // Any prerelease marker at all disqualifies the runtime; an invalid one
    // additionally makes the input malformed.
    if (!isValidPrerelease(prerelease)) return null;
  }

  var parts = text.split(".");
  if (parts.length !== 3) return null;
  if (!isValidNumericId(parts[0]) || !isValidNumericId(parts[1]) || !isValidNumericId(parts[2])) {
    return null;
  }

  if (!parts.every(function (part) { return Number.isSafeInteger(Number(part)); })) return null;

  return {
    major: Number(parts[0]),
    minor: Number(parts[1]),
    patch: Number(parts[2]),
    prerelease: prerelease,
    build: build,
  };
}

function rangeForMajor(major) {
  for (var i = 0; i < SUPPORTED_NODE_RANGES.length; i++) {
    if (SUPPORTED_NODE_RANGES[i].major === major) return SUPPORTED_NODE_RANGES[i];
  }
  return null;
}

/**
 * Pure predicate over a version string (or `process.version` shape).
 * Returns `{ ok, reason, ... }` where `reason` is null when ok, else one of:
 * "malformed" | "prerelease" | "unsupported-major" | "below-minimum".
 * Never throws for any input.
 */
export function checkNodeVersion(input) {
  var parsed;
  try {
    parsed = parseNodeVersion(input);
  } catch (err) {
    parsed = null;
  }
  if (parsed === null) {
    return { ok: false, reason: "malformed", major: null, minor: null, patch: null };
  }
  if (parsed.prerelease !== null) {
    return {
      ok: false,
      reason: "prerelease",
      major: parsed.major,
      minor: parsed.minor,
      patch: parsed.patch,
    };
  }
  var range = rangeForMajor(parsed.major);
  if (range === null) {
    return {
      ok: false,
      reason: "unsupported-major",
      major: parsed.major,
      minor: parsed.minor,
      patch: parsed.patch,
    };
  }
  if (
    parsed.minor < range.minMinor ||
    (parsed.minor === range.minMinor && parsed.patch < range.minPatch)
  ) {
    return {
      ok: false,
      reason: "below-minimum",
      major: parsed.major,
      minor: parsed.minor,
      patch: parsed.patch,
      minimum: range.major + "." + range.minMinor + "." + range.minPatch,
    };
  }
  return {
    ok: true,
    reason: null,
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
  };
}

/**
 * Actionable one-line-plus-detail message for a rejected runtime, or null
 * when the version is supported. `installed` defaults to `process.version`
 * so launcher and preload call sites share the shape; pass an explicit
 * string in tests. Never throws.
 */
export function formatNodeVersionError(installed, options) {
  var input = typeof installed === "undefined" ? process.version : installed;
  var versionText = typeof input === "string" && input.length > 0 ? input : "(unknown)";
  var result;
  try {
    result = checkNodeVersion(input);
  } catch (err) {
    result = { ok: false, reason: "malformed" };
  }
  if (result.ok) return null;

  var why =
    result.reason === "malformed"
      ? "could not be parsed as a Node version"
      : result.reason === "prerelease"
        ? "is a prerelease build, which is never a supported runtime"
        : result.reason === "unsupported-major"
          ? "is on an unsupported major line (only 22.x, 24.x and 26.x have verified fixes)"
          : "predates the verified fix on its line" +
            (result.minimum ? " (needs >=" + result.minimum + ")" : "");

  var extra = options && typeof options.hint === "string" && options.hint.length > 0 ? "\n" + options.hint : "";
  return (
    "Node.js " + versionText + " " + why + ".\n" +
    "Kady needs a Node runtime whose bundled undici contains the GHSA-xjj6-f33q-929c fix: " +
    SUPPORTED_NODE_DESCRIBE + ".\n" +
    "Install or select a supported release (https://nodejs.org/ or your version manager, e.g. 'nvm install 24'), then start Kady again." +
    extra
  );
}
