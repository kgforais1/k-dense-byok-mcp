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

  it("refuses a symlink whose target is a real directory", () => {
    // A path is what it points at, not how it is spelled. Nothing stops a temp
    // root from being a link to the production one — on macOS `/tmp` is itself
    // a link to `/private/tmp` — and a string comparison would admit it.
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-guard-link-"));
    const link = path.join(linkDir, "projects");
    fs.symlinkSync(path.join(serverDir, "..", "projects"), link);
    try {
      const { status, output } = importConfigWith({
        VITEST: "true",
        ...SAFE,
        KADY_PROJECTS_ROOT: link,
      });
      expect(status).not.toBe(0);
      expect(output).toContain("KADY_PROJECTS_ROOT resolves to");
    } finally {
      // Remove the link, never what it points at. `rmSync` on a symlink
      // unlinks it, but the recursive form would follow a directory link on
      // some platforms, which in this test is the repository's own projects
      // directory.
      fs.unlinkSync(link);
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked Pi agent directory too, not just the projects root", () => {
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-guard-link-pi-"));
    const link = path.join(linkDir, "pi-agent");
    const realPi = path.join(os.homedir(), ".kady", "pi-agent");
    // Skipped rather than created when it is absent. Creating it would mean a
    // test writing into the very directory this guard exists to protect, and
    // a dangling link cannot canonicalise to anything: `realpathSync` throws
    // and both sides fall back to lexical resolution, which is the behaviour
    // the other cases already cover.
    if (!fs.existsSync(realPi)) {
      fs.rmSync(linkDir, { recursive: true, force: true });
      return;
    }
    fs.symlinkSync(realPi, link);
    try {
      const { status, output } = importConfigWith({
        VITEST: "true",
        ...SAFE,
        PI_CODING_AGENT_DIR: link,
      });
      expect(status).not.toBe(0);
      expect(output).toContain("PI_CODING_AGENT_DIR resolves to");
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it("allows a temp directory that is not a link to anything real", () => {
    // The converse of the two above: canonicalising must not turn an ordinary
    // temp root into a false positive. On macOS `os.tmpdir()` sits under
    // `/var`, itself a link to `/private/var`, so this path canonicalises to
    // something quite different from how it was spelled.
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
