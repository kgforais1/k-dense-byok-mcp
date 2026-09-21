/**
 * The guard in `src/config.ts` that refuses to let a test run touch the real
 * user directories. It has to be exercised from a child process: this suite
 * has the overrides set, so importing the module here can only ever succeed.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Import `src/config.ts` in a child with `env`, and report how it went. */
function importConfigWith(env: Record<string, string | undefined>) {
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "-e", "import('./src/config.ts').then(() => console.log('imported'))"],
    {
      cwd: serverDir,
      encoding: "utf-8",
      env: { ...process.env, ...env },
    },
  );
  return { status: child.status, output: `${child.stdout}${child.stderr}` };
}

/**
 * A throwaway home directory, so a test can exercise the production paths
 * without going anywhere near the real ones. `os.homedir()` follows `HOME` on
 * POSIX, which is what makes `~/.kady/...` relocatable for the child.
 */
function withTempHome(body: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kady-guard-home-"));
  try {
    body(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const NO_OVERRIDES = {
  KADY_PROJECTS_ROOT: undefined,
  PI_CODING_AGENT_DIR: undefined,
  KADY_SKILLS_CACHE_DIR: undefined,
};

const SAFE = {
  KADY_PROJECTS_ROOT: "/tmp/kady-guard-projects",
  PI_CODING_AGENT_DIR: "/tmp/kady-guard-pi",
  KADY_SKILLS_CACHE_DIR: "/tmp/kady-guard-skills",
};

describe("the real-directory guard", () => {
  it("refuses a vitest run that has no directory overrides, naming all three", () => {
    const { status, output } = importConfigWith({ VITEST: "true", ...NO_OVERRIDES });
    expect(status).not.toBe(0);
    expect(output).toContain("Refusing to run tests against the real user directories");
    // All three, not just the first: a run that fixes one and re-runs should
    // not have to discover the next two one failure at a time.
    expect(output).toContain("KADY_PROJECTS_ROOT");
    expect(output).toContain("PI_CODING_AGENT_DIR");
    expect(output).toContain("KADY_SKILLS_CACHE_DIR");
    // The message has to say what to do instead, or it is just an obstacle.
    expect(output).toContain("npm test");
  });

  it("refuses a variable that is set, but set to the real directory", () => {
    // Being set is not the same as being safe. `env.ts` assigns
    // `PI_CODING_AGENT_DIR` the real `~/.kady/pi-agent` whenever it is unset,
    // so anything that imports it before `config.ts` would satisfy a presence
    // check while pointing the suite at the user's Pi credentials.
    const { status, output } = importConfigWith({
      VITEST: "true",
      ...SAFE,
      PI_CODING_AGENT_DIR: path.join(os.homedir(), ".kady", "pi-agent"),
    });
    expect(status).not.toBe(0);
    expect(output).toContain("PI_CODING_AGENT_DIR resolves to");
    expect(output).not.toContain("KADY_PROJECTS_ROOT resolves to");
  });

  it("refuses a projects root pointed at the repository's own directory", () => {
    const { status, output } = importConfigWith({
      VITEST: "true",
      ...SAFE,
      KADY_PROJECTS_ROOT: path.join(serverDir, "..", "projects"),
    });
    expect(status).not.toBe(0);
    expect(output).toContain("KADY_PROJECTS_ROOT resolves to");
  });

  it("refuses when only one override is missing, and names only that one", () => {
    const { status, output } = importConfigWith({
      VITEST: "true",
      ...NO_OVERRIDES,
      PI_CODING_AGENT_DIR: SAFE.PI_CODING_AGENT_DIR,
      KADY_SKILLS_CACHE_DIR: SAFE.KADY_SKILLS_CACHE_DIR,
    });
    expect(status).not.toBe(0);
    expect(output).toContain("KADY_PROJECTS_ROOT resolves to");
    expect(output).not.toContain("PI_CODING_AGENT_DIR resolves to");
  });

  it("treats a blank override as missing, not as an answer", () => {
    const { status, output } = importConfigWith({
      VITEST: "true",
      ...SAFE,
      KADY_PROJECTS_ROOT: "   ",
    });
    expect(status).not.toBe(0);
    // Reported as blank rather than resolved: `"   "` is a legal relative path,
    // so resolving it would name a directory nobody meant and send the reader
    // looking for it instead of at their environment.
    expect(output).toContain("KADY_PROJECTS_ROOT is blank");
  });

  it("refuses a symlink whose target is a production directory", () => {
    // A path is what it points at, not how it is spelled. Nothing stops a temp
    // root from being a link to a production one — on macOS `/tmp` is itself a
    // link to `/private/tmp` — and a string comparison would admit it.
    //
    // The link points at the skills cache while being fed to
    // `KADY_PROJECTS_ROOT`, which exercises the cross-variable check in the
    // same breath. It deliberately does not point at the repository's own
    // `projects/`: that directory is gitignored and does not exist on a fresh
    // checkout, so the link would dangle, canonicalise to nothing, and the
    // test would pass or fail depending on whose machine it ran on. It failed
    // exactly that way in CI.
    withTempHome((home) => {
      const realCache = path.join(home, ".kady", "skills-cache");
      fs.mkdirSync(realCache, { recursive: true });
      const link = path.join(home, "link-to-cache");
      fs.symlinkSync(realCache, link);
      const { status, output } = importConfigWith({
        VITEST: "true",
        ...SAFE,
        HOME: home,
        KADY_PROJECTS_ROOT: link,
      });
      expect(status).not.toBe(0);
      expect(output).toContain("KADY_PROJECTS_ROOT resolves to");
    });
  });

  it("refuses a symlinked Pi agent directory too, not just the projects root", () => {
    // Relocated rather than skipped. This used to bail out when
    // `~/.kady/pi-agent` was absent, which is most machines and every CI
    // runner — so the one case it named was the one it never ran.
    withTempHome((home) => {
      const realPi = path.join(home, ".kady", "pi-agent");
      fs.mkdirSync(realPi, { recursive: true });
      const link = path.join(home, "link-to-pi");
      fs.symlinkSync(realPi, link);
      const { status, output } = importConfigWith({
        VITEST: "true",
        ...SAFE,
        HOME: home,
        PI_CODING_AGENT_DIR: link,
      });
      expect(status).not.toBe(0);
      expect(output).toContain("PI_CODING_AGENT_DIR resolves to");
    });
  });

  it("refuses a directory that contains a production one", () => {
    // The dangerous direction. `~/.kady` is not equal to `~/.kady/pi-agent`,
    // so an equality check admits it — and then a `beforeEach` that removes
    // the tree takes the Pi auth store and the skills cache with it.
    withTempHome((home) => {
      fs.mkdirSync(path.join(home, ".kady", "pi-agent"), { recursive: true });
      const { status, output } = importConfigWith({
        VITEST: "true",
        ...SAFE,
        HOME: home,
        KADY_PROJECTS_ROOT: path.join(home, ".kady"),
      });
      expect(status).not.toBe(0);
      expect(output).toContain("KADY_PROJECTS_ROOT resolves to");
    });
  });

  it("refuses a directory inside a production one", () => {
    withTempHome((home) => {
      const scratch = path.join(home, ".kady", "pi-agent", "scratch");
      fs.mkdirSync(scratch, { recursive: true });
      const { status, output } = importConfigWith({
        VITEST: "true",
        ...SAFE,
        HOME: home,
        PI_CODING_AGENT_DIR: scratch,
      });
      expect(status).not.toBe(0);
      expect(output).toContain("PI_CODING_AGENT_DIR resolves to");
    });
  });

  it("allows a sibling of a production directory, not just anything under home", () => {
    // The containment check must not become "refuse everything near home".
    withTempHome((home) => {
      const sibling = path.join(home, ".kady-tests", "projects");
      fs.mkdirSync(sibling, { recursive: true });
      const { status, output } = importConfigWith({
        VITEST: "true",
        ...SAFE,
        HOME: home,
        KADY_PROJECTS_ROOT: sibling,
      });
      expect(output).toContain("imported");
      expect(status).toBe(0);
    });
  });

  it("allows a temp directory that is not a link to anything real", () => {
    // The converse of the cases above: canonicalising must not turn an
    // ordinary temp root into a false positive, which would throw at import
    // and take the whole suite with it. It does not catch a regression back
    // to string comparison — a temp path is lexically unrelated to a
    // production one, so both comparisons accept it — and it is not meant
    // to. It guards the direction where this check fails dangerously: by
    // refusing work that was fine.
    const realTemp = fs.mkdtempSync(path.join(os.tmpdir(), "kady-guard-real-"));
    try {
      const { status, output } = importConfigWith({
        VITEST: "true",
        ...SAFE,
        KADY_PROJECTS_ROOT: realTemp,
      });
      expect(output).toContain("imported");
      expect(status).toBe(0);
    } finally {
      fs.rmSync(realTemp, { recursive: true, force: true });
    }
  });

  it("allows the overridden run the suite actually uses", () => {
    const { status, output } = importConfigWith({ VITEST: "true", ...SAFE });
    expect(output).toContain("imported");
    expect(status).toBe(0);
  });

  it("leaves the running application alone", () => {
    // Without `VITEST` the defaults are the point: this is how Kady finds the
    // user's real projects. A guard that fired here would break `npm start`.
    const { status, output } = importConfigWith({ VITEST: undefined, ...NO_OVERRIDES });
    expect(output).toContain("imported");
    expect(status).toBe(0);
  });
});
