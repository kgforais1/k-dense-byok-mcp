/**
 * Regression tests for the PI_SUBAGENT_PI_BINARY seam redirect
 * (server/src/agent/pi-binary.ts + session-registry wiring).
 *
 * pi-subagents resolves the `pi` CLI it spawns for profile model probes
 * through `getPiSpawnCommand`, which prefers `PI_SUBAGENT_PI_BINARY` over
 * the installed package `bin` (the *bundled* CLI with inlined undici).
 * Kady points the seam at the installed *unbundled* `dist/cli.js`, which
 * loads npm-resolved undici through Pi's own dispatcher setup. Ordinary
 * foreground/background subagent runs never read this variable.
 *
 * Fail-safe contract under test:
 * - An explicit non-blank operator override wins verbatim; nothing else changes.
 * - Otherwise the resolved unbundled entry is ALWAYS configured, even when
 *   missing or non-executable, so a probe attempt fails visibly instead of
 *   silently reverting to the bundle (defects surface in `warnings`).
 * - Unresolvable entry, or (POSIX) no PATH entry realpath-equal to the
 *   verified backend Node, throws: startup must fail clearly rather than
 *   run probes on the bundle or an unverified runtime.
 *
 * Offline only: the only spawned processes are `pi --version` (prints and
 * exits; no network, no auth, no session) and a fake `node` used to prove
 * PATH handling. Fake env records are used throughout — the real
 * `process.env` is never mutated. No Pi patching, no prod changes.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PI_SUBAGENT_PI_BINARY_ENV, setupKadyPiBinary } from "../src/agent/pi-binary.ts";
import { piCliPath } from "../src/agent/mcp.ts";

// pi-spawn internals, imported by relative path (test-only pin: a Pi layout
// change fails loudly here for re-verification, not silently elsewhere).
import {
  PI_SUBAGENT_PI_BINARY_ENV as PLUGIN_ENV_KEY,
  getPiSpawnCommand,
} from "../node_modules/pi-subagents/src/runs/shared/pi-spawn.js";

const PI_PKG_DIR = path.join(
  path.dirname(piCliPath()),
  "..",
);
const PI_VERSION: string = JSON.parse(
  fs.readFileSync(path.join(PI_PKG_DIR, "package.json"), "utf-8"),
).version;

/** Probe-style args, mirroring profiles.js probeModel (minus the live probe). */
const PROBE_ARGS = ["-p", "--model", "openrouter/test-model", "--no-tools", "ok"];

function readVersion(pkgDir: string, name: string): string {
  let dir = pkgDir;
  for (;;) {
    const candidate = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8"));
      if (pkg.name === name) return pkg.version as string;
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`package ${name} not found above ${pkgDir}`);
    dir = parent;
  }
}

/** Real file usable as an unbundled entry; executable where POSIX needs it. */
function makeEntry(dirPrefix = "kady-pi-binary-"): { dir: string; entry: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), dirPrefix));
  const entry = path.join(dir, "cli.js");
  fs.writeFileSync(entry, "");
  try {
    fs.chmodSync(entry, 0o755);
  } catch {
    /* non-POSIX filesystems; win32 branch never checks the mode */
  }
  return { dir, entry };
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Faithful POSIX-style service root: a directory holding an executable
 * `node`, with execPath pointing at it. Lets platform-forced tests run on
 * any host OS without depending on the runner's own binary layout.
 */
function makeServiceRoot(): { dir: string; node: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady pi svc "));
  const node = path.join(dir, "node");
  fs.writeFileSync(node, "#!/bin/sh\nexit 0\n");
  try {
    fs.chmodSync(node, 0o755);
  } catch {
    /* best effort; realpath checks below need existence, not mode */
  }
  return { dir, node };
}

describe("setupKadyPiBinary (real assignment)", () => {
  it("overwrites a blank operator value with the Kady default", () => {
    const { entry, dir } = makeEntry();
    const svc = makeServiceRoot();
    try {
      const env: NodeJS.ProcessEnv = { [PI_SUBAGENT_PI_BINARY_ENV]: "  " };
      const setup = setupKadyPiBinary(env, entry, "linux", svc.node);
      expect(setup.action).toBe("kady-default");
      expect(setup.value).toBe(entry);
      expect(setup.warnings).toEqual([]);
      // The real assignment — not the old `??=` — so a blank operator value
      // can no longer silently preserve the bundled fallback.
      expect(env[PI_SUBAGENT_PI_BINARY_ENV]).toBe(entry);
    } finally {
      rmDir(dir);
      rmDir(svc.dir);
    }
  });

  it("preserves an intentional non-blank operator override verbatim", () => {
    const { entry, dir } = makeEntry();
    try {
      const env: NodeJS.ProcessEnv = {
        [PI_SUBAGENT_PI_BINARY_ENV]: "/operator/pi ",
        PATH: "/usr/bin:/bin",
      };
      const setup = setupKadyPiBinary(env, entry, "linux", "/opt/node/bin/node");
      expect(setup).toEqual({
        action: "operator",
        value: "/operator/pi",
        pathPrepended: false,
        warnings: [],
      });
      expect(env[PI_SUBAGENT_PI_BINARY_ENV]).toBe("/operator/pi ");
      expect(env.PATH).toBe("/usr/bin:/bin");
    } finally {
      rmDir(dir);
    }
  });

  it("throws on an unresolvable entry without touching env", () => {
    for (const bad of [null, undefined, ""]) {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
      expect(() => setupKadyPiBinary(env, bad, "linux", process.execPath)).toThrow(
        /could not resolve the installed unbundled Pi CLI/,
      );
      expect(PI_SUBAGENT_PI_BINARY_ENV in env).toBe(false);
      expect(env.PATH).toBe("/usr/bin");
    }
  });

  it("configures a missing entry anyway, with a precise warning", () => {
    const svc = makeServiceRoot();
    const missing = path.join(svc.dir, "absent-cli.js");
    try {
      const env: NodeJS.ProcessEnv = {};
      const setup = setupKadyPiBinary(env, missing, "linux", svc.node);
      // Always configured: a probe attempt fails visibly (spawn error) instead
      // of reverting to the known-vulnerable bundle.
      expect(setup.action).toBe("kady-default");
      expect(setup.value).toBe(missing);
      expect(env[PI_SUBAGENT_PI_BINARY_ENV]).toBe(missing);
      expect(setup.warnings).toHaveLength(1);
      expect(setup.warnings[0]).toContain("does not exist");
    } finally {
      rmDir(svc.dir);
    }
  });

  it.runIf(process.platform !== "win32")("configures a non-executable entry on POSIX anyway, with a precise warning", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-pi-binary-"));
    const svc = makeServiceRoot();
    try {
      const entry = path.join(dir, "cli.js");
      fs.writeFileSync(entry, "");
      fs.chmodSync(entry, 0o644);
      const env: NodeJS.ProcessEnv = {};
      const setup = setupKadyPiBinary(env, entry, "linux", svc.node);
      expect(setup.action).toBe("kady-default");
      expect(env[PI_SUBAGENT_PI_BINARY_ENV]).toBe(entry);
      expect(setup.warnings).toHaveLength(1);
      expect(setup.warnings[0]).toContain("not executable");
    } finally {
      rmDir(dir);
      rmDir(svc.dir);
    }
  });

  it("accepts the same non-executable entry on Windows without warnings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-pi-binary-"));
    try {
      const entry = path.join(dir, "cli.js");
      fs.writeFileSync(entry, "");
      try {
        fs.chmodSync(entry, 0o644);
      } catch {
        /* mode is irrelevant on win32 */
      }
      const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
      const setup = setupKadyPiBinary(env, entry, "win32", "C:\\node\\node.exe");
      expect(setup).toEqual({
        action: "kady-default",
        value: entry,
        pathPrepended: false,
        warnings: [],
      });
    } finally {
      rmDir(dir);
    }
  });

  it("throws when no PATH entry realpath-matches the verified backend Node", () => {
    const { entry, dir } = makeEntry();
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-pi-othernode-"));
    try {
      // nodeDir/node resolves to a DIFFERENT binary than execPath: the shebang
      // would run an unverified runtime, so setup must refuse.
      const otherNode = path.join(otherDir, "node");
      fs.writeFileSync(otherNode, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(otherNode, 0o755);
      const realLink = path.join(otherDir, "realnode");
      try {
        fs.symlinkSync(process.execPath, realLink);
      } catch {
        return; // symlink-restricted filesystem; nothing to prove here.
      }
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
      expect(() => setupKadyPiBinary(env, entry, "linux", realLink)).toThrow(
        /no PATH entry resolves to the verified backend Node/,
      );
      // Nothing configured: startup fails instead of aiming the shebang at
      // an unverified binary.
      expect(PI_SUBAGENT_PI_BINARY_ENV in env).toBe(false);
      expect(env.PATH).toBe("/usr/bin");
    } finally {
      rmDir(dir);
      rmDir(otherDir);
    }
  });

  it("accepts node layouts that realpath to the verified binary", () => {
    const { entry, dir } = makeEntry();
    // nvm-style layout: both names in the dir resolve to the backend binary.
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-pi-linknode-"));
    try {
      const realLink = path.join(linkDir, "realnode");
      const nodeLink = path.join(linkDir, "node");
      try {
        fs.symlinkSync(process.execPath, realLink);
        fs.symlinkSync(process.execPath, nodeLink);
      } catch {
        return; // symlink-restricted filesystem; nothing to prove here.
      }
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
      const setup = setupKadyPiBinary(env, entry, "linux", realLink);
      expect(setup.action).toBe("kady-default");
      expect(setup.pathPrepended).toBe(true);
      expect(env.PATH?.split(path.delimiter)[0]).toBe(linkDir);
      expect(env[PI_SUBAGENT_PI_BINARY_ENV]).toBe(entry);
    } finally {
      rmDir(dir);
      rmDir(linkDir);
    }
  });

  it("prepends exactly once without duplicating or dropping entries", () => {
    const svc = makeServiceRoot();
    const { entry, dir } = makeEntry();
    try {
      const before = `/usr/bin${path.delimiter}${svc.dir}${path.delimiter}/bin`;
      const env: NodeJS.ProcessEnv = { PATH: before };
      const setup = setupKadyPiBinary(env, entry, "linux", svc.node);
      expect(setup.action).toBe("kady-default");
      expect(setup.pathPrepended).toBe(true);
      expect(env.PATH).toBe(`${svc.dir}${path.delimiter}/usr/bin${path.delimiter}/bin`);
    } finally {
      rmDir(svc.dir);
      rmDir(dir);
    }
  });

  it("preserves meaningful empty PATH segments and handles an absent PATH", () => {
    const svc = makeServiceRoot();
    const { entry, dir } = makeEntry();
    try {
      // Empty segments spell the current directory on POSIX: keep them, move
      // only exact duplicates of the service directory.
      const before = ["", "/usr/bin", "", svc.dir, "/bin", ""].join(path.delimiter);
      const env: NodeJS.ProcessEnv = { PATH: before };
      const setup = setupKadyPiBinary(env, entry, "linux", svc.node);
      expect(setup.action).toBe("kady-default");
      expect(env.PATH).toBe([svc.dir, "", "/usr/bin", "", "/bin", ""].join(path.delimiter));
      // Absent PATH becomes exactly the service directory; an explicitly
      // empty PATH keeps its one (meaningful, current-directory) segment.
      const absentEnv: NodeJS.ProcessEnv = {};
      const absent = setupKadyPiBinary(absentEnv, entry, "linux", svc.node);
      expect(absent.action).toBe("kady-default");
      expect(absentEnv.PATH).toBe(svc.dir);
      const emptyEnv: NodeJS.ProcessEnv = { PATH: "" };
      const empty = setupKadyPiBinary(emptyEnv, entry, "linux", svc.node);
      expect(empty.action).toBe("kady-default");
      expect(emptyEnv.PATH).toBe(svc.dir + path.delimiter);
    } finally {
      rmDir(svc.dir);
      rmDir(dir);
    }
  });

  it("skips the PATH change on Windows", () => {
    const { entry, dir } = makeEntry();
    try {
      const winEnv: NodeJS.ProcessEnv = { PATH: "C:\\Windows;C:\\bin" };
      const win = setupKadyPiBinary(winEnv, entry, "win32", "C:\\node\\node.exe");
      expect(win.action).toBe("kady-default");
      expect(win.value).toBe(entry);
      expect(win.pathPrepended).toBe(false);
      expect(winEnv.PATH).toBe("C:\\Windows;C:\\bin");
    } finally {
      rmDir(dir);
    }
  });
});

describe("pi-spawn seam contract", () => {
  it("shares the env key with the installed pi-subagents", () => {
    expect(PI_SUBAGENT_PI_BINARY_ENV).toBe(PLUGIN_ENV_KEY);
    expect(PI_SUBAGENT_PI_BINARY_ENV).toBe("PI_SUBAGENT_PI_BINARY");
  });

  it("POSIX branch executes the override entry directly with identical args", () => {
    const cli = piCliPath();
    const spec = getPiSpawnCommand(PROBE_ARGS, {
      platform: "linux",
      env: { [PI_SUBAGENT_PI_BINARY_ENV]: cli } as NodeJS.ProcessEnv,
    });
    expect(spec).toEqual({ command: cli, args: PROBE_ARGS });
  });

  it("Windows branch runs the override entry through process.execPath", () => {
    const cli = piCliPath();
    const fakeNode = "C:\\fake\\node.exe";
    const spec = getPiSpawnCommand(PROBE_ARGS, {
      platform: "win32",
      execPath: fakeNode,
      env: { [PI_SUBAGENT_PI_BINARY_ENV]: cli } as NodeJS.ProcessEnv,
    });
    expect(spec).toEqual({ command: fakeNode, args: [cli, ...PROBE_ARGS] });
  });

  it("the override changes only the launcher, preserving probe args", () => {
    const cli = piCliPath();
    const overridden = getPiSpawnCommand(PROBE_ARGS, {
      platform: "linux",
      env: { [PI_SUBAGENT_PI_BINARY_ENV]: cli } as NodeJS.ProcessEnv,
    });
    const def = getPiSpawnCommand(PROBE_ARGS, {
      platform: "linux",
      env: {} as NodeJS.ProcessEnv,
    });
    // Default resolution launches the *bundled* entry here (proving the
    // redirect has something to redirect away from); the override swaps the
    // launcher while the trailing probe args are byte-identical.
    expect([def.command, ...def.args].join(" ")).toContain("bundle");
    expect([def.command, ...def.args]).not.toContain(cli);
    expect(def.args.slice(-PROBE_ARGS.length)).toEqual(PROBE_ARGS);
    expect(overridden.args).toEqual(PROBE_ARGS);
  });

  it("keeps spaced override paths intact on both branches", () => {
    const spaced = path.join(os.tmpdir(), "kady guard bin", "cli.js");
    const posix = getPiSpawnCommand(PROBE_ARGS, {
      platform: "linux",
      env: { [PI_SUBAGENT_PI_BINARY_ENV]: spaced } as NodeJS.ProcessEnv,
    });
    expect(posix).toEqual({ command: spaced, args: PROBE_ARGS });
    const windows = getPiSpawnCommand(PROBE_ARGS, {
      platform: "win32",
      execPath: "/fake/node",
      env: { [PI_SUBAGENT_PI_BINARY_ENV]: spaced } as NodeJS.ProcessEnv,
    });
    expect(windows).toEqual({ command: "/fake/node", args: [spaced, ...PROBE_ARGS] });
  });
});

describe("unbundled CLI client identity", () => {
  it("resolves to a real Node entry using the bare undici import", () => {
    const cli = piCliPath();
    expect(fs.statSync(cli).isFile()).toBe(true);
    expect(fs.readFileSync(cli, "utf-8").split("\n")[0]).toContain("node");
    const dispatcher = fs.readFileSync(
      path.join(PI_PKG_DIR, "dist", "core", "http-dispatcher.js"),
      "utf-8",
    );
    expect(dispatcher).toMatch(/from ["']undici["']/);
    expect(dispatcher).not.toContain("node_modules/undici");
  });

  it("resolves undici to the override-pinned npm copy, not an 8.10.x nested one", () => {
    const probeRequire = createRequire(
      path.join(PI_PKG_DIR, "dist", "core", "http-dispatcher.js"),
    );
    const undiciPath = probeRequire.resolve("undici");
    expect(readVersion(path.dirname(undiciPath), "undici")).toBe("8.12.3");
    // No nested copy may shadow the pinned one anywhere on the Pi path.
    expect(
      fs.existsSync(
        path.join(
          path.dirname(piCliPath()),
          "..",
          "..",
          "pi-subagents",
          "node_modules",
        ),
      ),
    ).toBe(false);
  });
});

describe("real unbundled CLI execution (offline, --version only)", () => {
  const posixOnly = process.platform === "win32" ? "shebang execution is POSIX-only" : false;

  it("POSIX spec runs and reports the installed Pi version, never the bundle", { skip: posixOnly }, () => {
    const cli = piCliPath();
    const spec = getPiSpawnCommand([], {
      platform: "linux",
      env: { [PI_SUBAGENT_PI_BINARY_ENV]: cli } as NodeJS.ProcessEnv,
    });
    expect(spec.command).toBe(cli);
    expect(spec.command).not.toContain("bundle");
    const result = spawnSync(spec.command, [...spec.args, "--version"], {
      encoding: "utf-8",
      timeout: 30000,
    });
    expect(result.status).toBe(0);
    expect((result.stdout || "").trim()).toBe(PI_VERSION);
  });

  it("Windows-branch spec (execPath + entry) runs the same binary", () => {
    const cli = piCliPath();
    const spec = getPiSpawnCommand([], {
      platform: "win32",
      execPath: process.execPath,
      env: { [PI_SUBAGENT_PI_BINARY_ENV]: cli } as NodeJS.ProcessEnv,
    });
    expect(spec.command).toBe(process.execPath);
    const result = spawnSync(spec.command, [...spec.args, "--version"], {
      encoding: "utf-8",
      timeout: 30000,
    });
    expect(result.status).toBe(0);
    expect((result.stdout || "").trim()).toBe(PI_VERSION);
  });

  it("end-to-end: setup output drives a non-bundled spawn", { skip: posixOnly }, () => {
    const svc = makeServiceRoot();
    try {
      const setup = setupKadyPiBinary({}, piCliPath(), "linux", svc.node);
      expect(setup.action).toBe("kady-default");
      expect(setup.warnings).toEqual([]);
      const env: NodeJS.ProcessEnv = { ...process.env, [PI_SUBAGENT_PI_BINARY_ENV]: setup.value };
      const spec = getPiSpawnCommand([], {
        platform: "linux",
        env: { [PI_SUBAGENT_PI_BINARY_ENV]: setup.value } as NodeJS.ProcessEnv,
      });
      expect(spec.command).toBe(setup.value);
      expect(spec.command).not.toContain("bundle");
      const result = spawnSync(spec.command, [...spec.args, "--version"], {
        env,
        encoding: "utf-8",
        timeout: 30000,
      });
      expect(result.status).toBe(0);
      expect((result.stdout || "").trim()).toBe(PI_VERSION);
    } finally {
      rmDir(svc.dir);
    }
  });

  it("a missing CLI entry fails spawn visibly without invoking the bundle", () => {
    const missing = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "kady-pi-binary-")),
      "absent-cli.js",
    );
    const dir = path.dirname(missing);
    try {
      // The seam points at the (missing) unbundled path: the spawn itself
      // must fail — never silently fall through to the bundled CLI.
      const spec = getPiSpawnCommand([], {
        platform: process.platform,
        execPath: process.execPath,
        env: { [PI_SUBAGENT_PI_BINARY_ENV]: missing } as NodeJS.ProcessEnv,
      });
      expect([spec.command, ...spec.args].join(" ")).not.toContain("bundle");
      const result = spawnSync(spec.command, [...spec.args, "--version"], {
        encoding: "utf-8",
        timeout: 30000,
      });
      expect(result.error !== undefined || result.status !== 0).toBe(true);
    } finally {
      rmDir(dir);
    }
  });

  it.runIf(process.platform !== "win32")("runs through a path containing spaces", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady guard bin "));
    try {
      const link = path.join(dir, "cli.js");
      try {
        fs.symlinkSync(piCliPath(), link);
      } catch {
        // Symlink-restricted filesystems: the spaced-string parity above
        // still pins argument handling; nothing to execute here.
        return;
      }
      const spec = getPiSpawnCommand([], {
        platform: "linux",
        env: { [PI_SUBAGENT_PI_BINARY_ENV]: link } as NodeJS.ProcessEnv,
      });
      const result = spawnSync(spec.command, [...spec.args, "--version"], {
        encoding: "utf-8",
        timeout: 30000,
      });
      expect(result.status).toBe(0);
      expect((result.stdout || "").trim()).toBe(PI_VERSION);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hostile-PATH probe execution (POSIX)", () => {
  const posixOnly = process.platform === "win32" ? "shebang PATH resolution is POSIX-only" : false;

  function hostileEnv(nodeDir: string, fakeDir: string): NodeJS.ProcessEnv {
    // Intentionally conflicting PATH: a fake `node` that fails comes first,
    // exactly what a hostile or stale PATH entry would do to the shebang.
    return {
      ...process.env,
      PATH: `${fakeDir}${path.delimiter}${nodeDir}${path.delimiter}/usr/bin`,
    };
  }

  function makeFakeNode(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady guard fakenode "));
    const bin = path.join(dir, "node");
    fs.writeFileSync(bin, "#!/bin/sh\necho FAKE-NODE >&2\nexit 99\n");
    fs.chmodSync(bin, 0o755);
    return dir;
  }

  function rmFakeNode(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  it("shebang resolution without the fix picks the fake node", { skip: posixOnly }, () => {
    const fakeDir = makeFakeNode();
    try {
      // Sensitivity control: with the fake first and no setup, `env node`
      // resolution (what the shebang does) finds the fake.
      const probe = spawnSync("node", ["--version"], {
        env: hostileEnv("/nonexistent-node-dir", fakeDir),
        encoding: "utf-8",
        timeout: 30000,
      });
      expect(probe.status).not.toBe(0);
    } finally {
      rmFakeNode(fakeDir);
    }
  });

  it("setup prepends the verified service Node dir so the probe survives the hostile PATH", { skip: posixOnly }, () => {
    const serviceNodeDir = path.dirname(process.execPath);
    const fakeDir = makeFakeNode();
    try {
      const cli = piCliPath();
      const env: NodeJS.ProcessEnv = hostileEnv(serviceNodeDir, fakeDir);
      const setup = setupKadyPiBinary(env, cli, "linux", process.execPath);
      expect(setup.action).toBe("kady-default");
      expect(setup.pathPrepended).toBe(true);
      expect(env.PATH?.split(path.delimiter)[0]).toBe(serviceNodeDir);
      // The actual spawn shape pi-subagents will use for probes.
      const spec = getPiSpawnCommand([], {
        platform: "linux",
        env: { ...env, [PI_SUBAGENT_PI_BINARY_ENV]: cli } as NodeJS.ProcessEnv,
      });
      const result = spawnSync(spec.command, [...spec.args, "--version"], {
        env,
        encoding: "utf-8",
        timeout: 30000,
      });
      expect(result.status).toBe(0);
      expect((result.stdout || "").trim()).toBe(PI_VERSION);
      expect(result.stderr || "").not.toContain("FAKE-NODE");
    } finally {
      rmFakeNode(fakeDir);
    }
  });

  it("an operator override is preserved verbatim under the same hostile PATH", { skip: posixOnly }, () => {
    const serviceNodeDir = path.dirname(process.execPath);
    const fakeDir = makeFakeNode();
    try {
      const env = hostileEnv(serviceNodeDir, fakeDir);
      env[PI_SUBAGENT_PI_BINARY_ENV] = "/operator/pi";
      const setup = setupKadyPiBinary(env, piCliPath(), "linux", process.execPath);
      expect(setup.action).toBe("operator");
      expect(env[PI_SUBAGENT_PI_BINARY_ENV]).toBe("/operator/pi");
      // Untouched PATH still leads with the fake: the operator owns this.
      expect(env.PATH?.split(path.delimiter)[0]).toBe(fakeDir);
    } finally {
      rmFakeNode(fakeDir);
    }
  });
});
