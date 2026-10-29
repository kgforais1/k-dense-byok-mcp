/**
 * Regression tests for the PI_SUBAGENT_PI_BINARY seam redirect
 * (server/src/agent/pi-binary.ts + session-registry wiring).
 *
 * pi-subagents resolves the `pi` CLI it spawns for profile model probes
 * through `getPiSpawnCommand`, which prefers `PI_SUBAGENT_PI_BINARY` over
 * the installed package `bin` (the *bundled* CLI with inlined undici).
 * Kady points the seam at its own POSIX launcher (`scripts/kady-pi.sh`,
 * which execs the exact backend Node on the installed unbundled
 * `dist/cli.js`); on Windows the seam points directly at the unbundled
 * entry (pi-spawn runs `process.execPath + entry` there). Ordinary
 * foreground/background subagent runs never read this variable.
 *
 * Fail-safe contract under test:
 * - An explicit non-blank operator override wins verbatim; nothing else changes.
 * - Otherwise the launcher (POSIX) or unbundled entry (Windows) is ALWAYS
 *   configured, even when files are missing or non-executable: a probe
 *   attempt then fails visibly instead of silently reverting to the bundle.
 * - Unresolvable entries throw: startup fails clearly.
 * - The launcher never consults PATH for Node (absolute `KADY_NODE_BIN`);
 *   `process.env` itself is never rewritten except the seam variable (and,
 *   on POSIX kady-default, the two launcher variables).
 *
 * Offline only: the only spawned processes are `pi --version` (prints and
 * exits; no network, no auth, no session), a fixture argv-echo script, and a
 * fake `node` used to prove PATH independence. Fake env records are used
 * throughout — the real `process.env` is never mutated. No Pi patching, no
 * prod changes.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  KADY_NODE_BIN_ENV,
  KADY_PI_CLI_ENV,
  PI_SUBAGENT_PI_BINARY_ENV,
  kadyPiLauncherPath,
  setupKadyPiBinary,
} from "../src/agent/pi-binary.ts";
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

/** Scratch dir acting as a fake service Node installation (POSIX-readable). */
function makeServiceRoot(dirPrefix = "kady-pi-svc-"): { dir: string; node: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), dirPrefix));
  const node = path.join(dir, "node");
  fs.writeFileSync(node, "#!/bin/sh\nexit 0\n");
  return { dir, node };
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function realLauncher(): string {
  const launcher = kadyPiLauncherPath();
  expect(fs.statSync(launcher).isFile()).toBe(true);
  return launcher;
}

describe("setupKadyPiBinary (real assignment)", () => {
  it("overwrites a blank operator value with the Kady default", () => {
    const { entry, dir } = makeEntry();
    const svc = makeServiceRoot();
    try {
      const env: NodeJS.ProcessEnv = { [PI_SUBAGENT_PI_BINARY_ENV]: "  " };
      const setup = setupKadyPiBinary(env, {
        unbundledEntry: entry,
        launcherEntry: realLauncher(),
        platform: "linux",
        execPath: svc.node,
      });
      expect(setup.action).toBe("kady-default");
      expect(setup.value).toBe(realLauncher());
      expect(setup.warnings).toEqual([]);
      // The real assignment — not the old `??=` — so a blank operator value
      // can no longer silently preserve the bundled fallback.
      expect(env[PI_SUBAGENT_PI_BINARY_ENV]).toBe(realLauncher());
      expect(env[KADY_NODE_BIN_ENV]).toBe(svc.node);
      expect(env[KADY_PI_CLI_ENV]).toBe(entry);
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
        [KADY_NODE_BIN_ENV]: "/should/not/change",
      };
      const setup = setupKadyPiBinary(env, {
        unbundledEntry: entry,
        launcherEntry: realLauncher(),
        platform: "linux",
        execPath: "/opt/node/bin/node",
      });
      expect(setup).toEqual({
        action: "operator",
        value: "/operator/pi",
        warnings: [],
      });
      expect(env[PI_SUBAGENT_PI_BINARY_ENV]).toBe("/operator/pi ");
      expect(env.PATH).toBe("/usr/bin:/bin");
      expect(env[KADY_NODE_BIN_ENV]).toBe("/should/not/change");
      expect(KADY_PI_CLI_ENV in env).toBe(false);
    } finally {
      rmDir(dir);
    }
  });

  it("throws on an unresolvable entry without touching env", () => {
    const svc = makeServiceRoot();
    try {
      for (const bad of [null, undefined, ""]) {
        const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
        expect(() =>
          setupKadyPiBinary(env, {
            unbundledEntry: bad,
            launcherEntry: realLauncher(),
            platform: "linux",
            execPath: svc.node,
          }),
        ).toThrow(/could not resolve the installed unbundled Pi CLI/);
        expect(PI_SUBAGENT_PI_BINARY_ENV in env).toBe(false);
        expect(env.PATH).toBe("/usr/bin");
      }
    } finally {
      rmDir(svc.dir);
    }
  });

  it("throws on an unresolvable launcher on POSIX without touching env", () => {
    const svc = makeServiceRoot();
    const { entry, dir } = makeEntry();
    try {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
      expect(() =>
        setupKadyPiBinary(env, { unbundledEntry: entry, launcherEntry: null, platform: "linux", execPath: svc.node }),
      ).toThrow(/could not resolve the Kady Pi launcher/);
      expect(PI_SUBAGENT_PI_BINARY_ENV in env).toBe(false);
    } finally {
      rmDir(dir);
      rmDir(svc.dir);
    }
  });

  it("configures a missing CLI anyway, with a precise warning", () => {
    const svc = makeServiceRoot();
    const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-pi-binary-"));
    try {
      const missing = path.join(missingDir, "absent-cli.js");
      const env: NodeJS.ProcessEnv = {};
      const setup = setupKadyPiBinary(env, {
        unbundledEntry: missing,
        launcherEntry: realLauncher(),
        platform: "linux",
        execPath: svc.node,
      });
      // Always configured: a probe attempt fails visibly (spawn error) instead
      // of reverting to the known-vulnerable bundle.
      expect(setup.action).toBe("kady-default");
      expect(setup.value).toBe(realLauncher());
      expect(env[PI_SUBAGENT_PI_BINARY_ENV]).toBe(realLauncher());
      expect(env[KADY_PI_CLI_ENV]).toBe(missing);
      expect(setup.warnings).toHaveLength(1);
      expect(setup.warnings[0]).toContain("does not exist");
    } finally {
      rmDir(missingDir);
      rmDir(svc.dir);
    }
  });

  // POSIX-only: chmod-based non-executability has no meaning on Windows,
  // where this file's win32 branch never consults the exec bit (covered by
  // the Windows test below instead).
  it.skipIf(process.platform === "win32")("configures a non-executable launcher on POSIX anyway, with a precise warning", () => {
    const svc = makeServiceRoot();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-pi-binary-"));
    try {
      const entry = path.join(dir, "cli.js");
      fs.writeFileSync(entry, "");
      const launcherCopy = path.join(dir, "kady-pi-copy.sh");
      fs.writeFileSync(launcherCopy, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(launcherCopy, 0o644);
      const env: NodeJS.ProcessEnv = {};
      const setup = setupKadyPiBinary(env, {
        unbundledEntry: entry,
        launcherEntry: launcherCopy,
        platform: "linux",
        execPath: svc.node,
      });
      expect(setup.action).toBe("kady-default");
      expect(env[PI_SUBAGENT_PI_BINARY_ENV]).toBe(launcherCopy);
      expect(setup.warnings).toHaveLength(1);
      expect(setup.warnings[0]).toContain("not executable");
    } finally {
      rmDir(dir);
      rmDir(svc.dir);
    }
  });

  it("accepts the same non-executable launcher on Windows without warnings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-pi-binary-"));
    try {
      const entry = path.join(dir, "cli.js");
      fs.writeFileSync(entry, "");
      const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
      const setup = setupKadyPiBinary(env, {
        unbundledEntry: entry,
        launcherEntry: "C:\\kady\\kady-pi.sh",
        platform: "win32",
        execPath: "C:\\node\\node.exe",
      });
      expect(setup).toEqual({
        action: "kady-default",
        value: entry,
        warnings: [],
      });
      expect(env[PI_SUBAGENT_PI_BINARY_ENV]).toBe(entry);
      expect(KADY_NODE_BIN_ENV in env).toBe(false);
      expect(KADY_PI_CLI_ENV in env).toBe(false);
    } finally {
      rmDir(dir);
    }
  });

  it("leaves PATH byte-for-byte alone", () => {
    const svc = makeServiceRoot();
    const { entry, dir } = makeEntry();
    try {
      const before = `/usr/bin${path.delimiter}/bin${path.delimiter}`;
      const env: NodeJS.ProcessEnv = { PATH: before };
      const setup = setupKadyPiBinary(env, {
        unbundledEntry: entry,
        launcherEntry: realLauncher(),
        platform: "linux",
        execPath: svc.node,
      });
      expect(setup.action).toBe("kady-default");
      expect(env.PATH).toBe(before);
    } finally {
      rmDir(dir);
      rmDir(svc.dir);
    }
  });

  it("leaves an absent PATH absent", () => {
    const svc = makeServiceRoot();
    const { entry, dir } = makeEntry();
    try {
      const env: NodeJS.ProcessEnv = {};
      setupKadyPiBinary(env, {
        unbundledEntry: entry,
        launcherEntry: realLauncher(),
        platform: "linux",
        execPath: svc.node,
      });
      expect("PATH" in env).toBe(false);
    } finally {
      rmDir(dir);
      rmDir(svc.dir);
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
    // The runner resolves from pi-subagents, an unscoped sibling of the
    // scoped Pi package. Check the nested package and actual resolution.
    const subagentsDir = path.resolve(PI_PKG_DIR, "..", "..", "pi-subagents");
    expect(fs.existsSync(path.join(subagentsDir, "node_modules", "undici"))).toBe(false);
    const runnerRequire = createRequire(
      path.join(subagentsDir, "src", "runs", "background", "runner-http-dispatcher.js"),
    );
    expect(fs.realpathSync(runnerRequire.resolve("undici"))).toBe(fs.realpathSync(undiciPath));
  });
});

describe("Kady launcher execution (offline, --version only)", () => {
  const posixOnly = process.platform === "win32" ? "shebang execution is POSIX-only" : false;

  it("end-to-end: setup output drives a non-bundled spawn", { skip: posixOnly }, () => {
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-pi-linksvc "));
    const cli = piCliPath();
    try {
      // Service root where `node` resolves to the verified backend binary.
      const realLink = path.join(linkDir, "realnode");
      const nodeLink = path.join(linkDir, "node");
      try {
        fs.symlinkSync(process.execPath, realLink);
        fs.symlinkSync(process.execPath, nodeLink);
      } catch {
        // Symlink-restricted filesystem; nothing to prove here.
        return;
      }
      const setupEnv: NodeJS.ProcessEnv = {};
      const setup = setupKadyPiBinary(setupEnv, {
        unbundledEntry: cli,
        launcherEntry: realLauncher(),
        platform: "linux",
        execPath: realLink,
      });
      expect(setup.action).toBe("kady-default");
      expect(setup.value).toBe(realLauncher());
      expect(setup.warnings).toEqual([]);
      expect(setupEnv[PI_SUBAGENT_PI_BINARY_ENV]).toBe(realLauncher());
      // The actual spawn shape pi-subagents will use for probes.
      const spec = getPiSpawnCommand([], {
        platform: "linux",
        env: { [PI_SUBAGENT_PI_BINARY_ENV]: setup.value } as NodeJS.ProcessEnv,
      });
      expect(spec.command).toBe(realLauncher());
      expect(spec.command).not.toContain("bundle");
      const result = spawnSync(spec.command, [...spec.args, "--version"], {
        env: { ...process.env, [KADY_NODE_BIN_ENV]: process.execPath, [KADY_PI_CLI_ENV]: cli },
        encoding: "utf-8",
        timeout: 30000,
      });
      expect(result.status).toBe(0);
      expect((result.stdout || "").trim()).toBe(PI_VERSION);
    } finally {
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it("real unbundled --version through the launcher is the installed Pi", { skip: posixOnly }, () => {
    const cli = piCliPath();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KADY_NODE_BIN: process.execPath,
      KADY_PI_CLI: cli,
    };
    const result = spawnSync(realLauncher(), ["--version"], {
      env,
      encoding: "utf-8",
      timeout: 30000,
    });
    expect(result.status).toBe(0);
    expect((result.stdout || "").trim()).toBe(PI_VERSION);
  });

  it("ignores a hostile PATH entirely (fake node first)", { skip: posixOnly }, () => {
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "kady guard fakenode "));
    try {
      const fake = path.join(fakeDir, "node");
      fs.writeFileSync(fake, "#!/bin/sh\necho FAKE-NODE >&2\nexit 99\n");
      fs.chmodSync(fake, 0o755);
      const cli = piCliPath();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${fakeDir}${path.delimiter}/usr/bin:/bin`,
        KADY_NODE_BIN: process.execPath,
        KADY_PI_CLI: cli,
      };
      // Sensitivity control: bare `node` resolves to the fake.
      const direct = spawnSync("node", ["--version"], { env, encoding: "utf-8", timeout: 30000 });
      expect(direct.status).not.toBe(0);
      // The launcher never consults PATH for Node.
      const result = spawnSync(realLauncher(), ["--version"], {
        env,
        encoding: "utf-8",
        timeout: 30000,
      });
      expect(result.status).toBe(0);
      expect((result.stdout || "").trim()).toBe(PI_VERSION);
      expect(result.stderr || "").not.toContain("FAKE-NODE");
    } finally {
      fs.rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it("forwards exact argv, including spaces and metacharacters", { skip: posixOnly }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-pi-argv "));
    try {
      const echoArgv = path.join(dir, "echo-argv.mjs");
      fs.writeFileSync(
        echoArgv,
        "console.log(JSON.stringify(process.argv.slice(2)));\n",
      );
      const wanted = ["hello world", "a&b", "--flag=x", "semi;colon", "$dollar"];
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        KADY_NODE_BIN: process.execPath,
        KADY_PI_CLI: echoArgv,
      };
      const result = spawnSync(realLauncher(), wanted, { env, encoding: "utf-8", timeout: 30000 });
      expect(result.status).toBe(0);
      expect(JSON.parse((result.stdout || "").trim())).toEqual(wanted);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs through a path containing spaces", { skip: posixOnly }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady guard spaced "));
    try {
      const linkLauncher = path.join(dir, "kady-pi.sh");
      const linkCli = path.join(dir, "cli.js");
      try {
        fs.symlinkSync(realLauncher(), linkLauncher);
        fs.symlinkSync(piCliPath(), linkCli);
      } catch {
        // Symlink-restricted filesystems: the spaced-string parity above
        // still pins argument handling; nothing to execute here.
        return;
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        KADY_NODE_BIN: process.execPath,
        KADY_PI_CLI: linkCli,
      };
      const result = spawnSync(linkLauncher, ["--version"], {
        env,
        encoding: "utf-8",
        timeout: 30000,
      });
      expect(result.status).toBe(0);
      expect((result.stdout || "").trim()).toBe(PI_VERSION);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing KADY_NODE_BIN fails loudly without touching the bundle", { skip: posixOnly }, () => {
    const env: NodeJS.ProcessEnv = { ...process.env, KADY_PI_CLI: piCliPath() };
    delete env[KADY_NODE_BIN_ENV];
    const result = spawnSync(realLauncher(), ["--version"], {
      env,
      encoding: "utf-8",
      timeout: 30000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr || "").toMatch(/KADY_NODE_BIN/);
  });

  it("missing KADY_PI_CLI fails loudly without touching the bundle", { skip: posixOnly }, () => {
    const env: NodeJS.ProcessEnv = { ...process.env, KADY_NODE_BIN: process.execPath };
    delete env[KADY_PI_CLI_ENV];
    const result = spawnSync(realLauncher(), ["--version"], {
      env,
      encoding: "utf-8",
      timeout: 30000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr || "").toMatch(/KADY_PI_CLI/);
  });

  it("a missing CLI file fails visibly through the launcher", { skip: posixOnly }, () => {
    const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-pi-binary-"));
    try {
      const missing = path.join(missingDir, "absent-cli.js");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        KADY_NODE_BIN: process.execPath,
        KADY_PI_CLI: missing,
      };
      const result = spawnSync(realLauncher(), ["--version"], {
        env,
        encoding: "utf-8",
        timeout: 30000,
      });
      expect(result.status).not.toBe(0);
      // Node reports the missing file; nothing about the bundle appears.
      expect(`${result.stdout || ""}${result.stderr || ""}`).not.toContain("bundle");
    } finally {
      rmDir(missingDir);
    }
  });

  it("a non-executable launcher copy fails visibly", { skip: posixOnly }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-pi-binary-"));
    try {
      const copy = path.join(dir, "kady-pi-copy.sh");
      fs.writeFileSync(copy, fs.readFileSync(realLauncher(), "utf-8"));
      fs.chmodSync(copy, 0o644);
      const result = spawnSync(copy, ["--version"], {
        env: { ...process.env, KADY_NODE_BIN: process.execPath, KADY_PI_CLI: piCliPath() },
        encoding: "utf-8",
        timeout: 30000,
      });
      // EACCES at exec: loud, immediate, and nothing else ran.
      expect(result.error !== undefined || result.status !== 0).toBe(true);
    } finally {
      rmDir(dir);
    }
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
});

describe("missing-entry spawn fails without invoking the bundle", () => {
  it("a missing CLI entry fails spawn without invoking the bundle", () => {
    const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-pi-binary-"));
    try {
      const missing = path.join(missingDir, "absent-cli.js");
      const spec = getPiSpawnCommand([], {
        platform: process.platform,
        execPath: process.execPath,
        env: { [PI_SUBAGENT_PI_BINARY_ENV]: missing } as NodeJS.ProcessEnv,
      });
      if (process.platform === "win32") {
        expect(spec.command).toBe(process.execPath);
      } else {
        expect(spec.command).toBe(missing);
      }
      const result = spawnSync(spec.command, [...spec.args, "--version"], {
        encoding: "utf-8",
        timeout: 30000,
      });
      expect(result.error !== undefined || result.status !== 0).toBe(true);
      expect([spec.command, ...spec.args].join(" ")).not.toContain("bundle");
    } finally {
      rmDir(missingDir);
    }
  });
});
