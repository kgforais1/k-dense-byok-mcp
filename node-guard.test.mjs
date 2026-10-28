/**
 * Focused tests for scripts/node-guard.mjs (`node --import` runtime guard)
 * and the chunk-2 wiring.
 *
 * Runs on the standard Node test runner with no dependencies, no network,
 * and no real services:
 *
 *   node --test node-guard.test.mjs
 *
 * Strategy: the guard runs inside the spawned process under test, so bad
 * runtimes fail for real and good runtimes pass for real. Acceptance tests
 * default to process.execPath when the host itself passes the policy (e.g.
 * CI on a supported line), else use a verified KADY_VERIFY_NODE_BIN, else
 * skip. Nothing here alters any installed Node. All temp dirs (including
 * ones with spaces in their names) are removed afterwards.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkNodeVersion } from "./node-policy.mjs";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(REPO_ROOT, "scripts", "node-guard.mjs");
const HOST_NODE = process.execPath;
const HOST_SUPPORTED = checkNodeVersion(process.version).ok;

const TEMP_DIRS = [];
function makeTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      /* best-effort cleanup */
    }
  }
});

/** A supported binary for accept-path tests, or null (those tests skip). */
function supportedNodeBin() {
  if (HOST_SUPPORTED) return HOST_NODE;
  const candidate = process.env.KADY_VERIFY_NODE_BIN;
  if (!candidate) return null;
  try {
    if (!fs.statSync(candidate).isFile()) return null;
    const probed = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
    if (probed.status !== 0) return null;
    if (!checkNodeVersion((probed.stdout || "").trim()).ok) return null;
    return candidate;
  } catch (err) {
    return null;
  }
}

const SUPPORTED_NODE = supportedNodeBin();

/** Skip reason for the tsx watch descendant test, or false when runnable. */
function watchSkipReason() {
  if (!SUPPORTED_NODE) {
    return "no supported Node (host rejected and KADY_VERIFY_NODE_BIN unset/invalid)";
  }
  try {
    if (!fs.statSync(path.join(REPO_ROOT, "server", "node_modules", "tsx", "dist", "cli.mjs")).isFile()) {
      return "server dependencies not installed (tsx missing)";
    }
  } catch (err) {
    return "server dependencies not installed (tsx missing)";
  }
  return false;
}

/**
 * Minimal CLI fixture: no package needed, invoked directly as the `--import`
 * target's entry. Modes via env: `exit` writes a JSON record and exits with
 * KADY_GATE_EXIT; `count` tallies received signals, writes `count`/`done`,
 * and exits 0 after a grace window so a duplicate delivery would be seen.
 */
function makeFixture() {
  // Space in the prefix: every spawn test below exercises spaced paths.
  const root = makeTemp("kady guard test-");
  const cli = path.join(root, "cli.mjs");
  fs.writeFileSync(
    cli,
    [
      "import fs from 'node:fs';",
      "const dir = process.env.KADY_GUARD_FIXTURE_DIR || '';",
      "const mode = process.env.KADY_GUARD_MODE || 'exit';",
      "if (mode === 'count') {",
      "  const countFile = dir + '/count';",
      "  const bump = () => {",
      "    let n = 0;",
      "    try { n = Number(fs.readFileSync(countFile, 'utf-8')) || 0; } catch (e) {}",
      "    fs.writeFileSync(countFile, String(n + 1));",
      "  };",
      "  let scheduled = false;",
      "  const onSignal = () => {",
      "    bump();",
      "    if (!scheduled) {",
      "      scheduled = true;",
      "      setTimeout(() => {",
      "        try { fs.writeFileSync(dir + '/done', 'counted'); } catch (e) {}",
      "        process.exit(0);",
      "      }, 400);",
      "    }",
      "  };",
      "  process.on('SIGTERM', onSignal);",
      "  process.on('SIGINT', onSignal);",
      "  setInterval(() => {}, 10000);",
      "  // Ready is written only after the handlers are installed: a signal",
      "  // arriving in between would otherwise be missed under a loaded CI.",
      "  if (dir) { try { fs.writeFileSync(dir + '/ready', String(process.pid)); } catch (e) {} }",
      "} else {",
      "  const out = process.env.KADY_GUARD_FIXTURE_OUT;",
      "  if (dir) { try { fs.writeFileSync(dir + '/ready', String(process.pid)); } catch (e) {} }",
      "  if (out) {",
      "    fs.writeFileSync(out, JSON.stringify({",
      "      execPath: process.execPath,",
      "      version: process.version,",
      "      argv: process.argv.slice(2),",
      "      marker: process.env.KADY_GUARD_MARKER || null,",
      "    }));",
      "  }",
      "  process.exit(Number(process.env.KADY_GUARD_EXIT || '0'));",
      "}",
      "",
    ].join("\n"),
  );
  return { root: root, cli: cli };
}

function runGuardSync(nodeBin, entryArgs, options) {
  const opts = options || {};
  return spawnSync(nodeBin, ["--import", GUARD].concat(entryArgs), {
    cwd: opts.cwd || REPO_ROOT,
    env: opts.env || process.env,
    encoding: "utf-8",
    timeout: 30000,
  });
}

function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 10000);
  while (Date.now() < deadline) {
    try {
      if (fs.statSync(filePath).isFile()) return true;
    } catch (err) {
      /* not yet */
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return false;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for process exit"));
    }, timeoutMs || 15000);
    if (typeof timer.unref === "function") timer.unref();
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code, signal: signal });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Parse the wired npm script into [node, --import, guard, entry, ...rest],
 * asserting the expected shape. Callers substitute a safe tail (e.g.
 * --version) so no service ever starts.
 */
function wiredScriptParts(pkgDir, scriptName) {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, pkgDir, "package.json"), "utf-8"));
  const script = pkg.scripts[scriptName];
  assert.equal(typeof script, "string");
  const tokens = script.split(" ");
  assert.equal(tokens[0], "node");
  assert.equal(tokens[1], "--import");
  assert.ok(tokens[2].endsWith("scripts/node-guard.mjs"), "guard path: " + tokens[2]);
  const entry = path.resolve(REPO_ROOT, pkgDir, tokens[3]);
  assert.ok(fs.statSync(entry).isFile(), "wired entry must exist: " + entry);
  return { nodeTok: tokens[0], importFlag: tokens[1], guard: tokens[2], entry: tokens[3], rest: tokens.slice(4) };
}

describe("wiring (static, no spawn)", () => {
  it("server/web scripts route services through the in-process guard", () => {
    const cases = [
      ["server", "dev", "./node_modules/tsx/dist/cli.mjs"],
      ["server", "start", "./node_modules/tsx/dist/cli.mjs"],
      ["server", "prep", "./node_modules/tsx/dist/cli.mjs"],
      ["web", "dev", "./node_modules/next/dist/bin/next"],
      ["web", "build", "./node_modules/next/dist/bin/next"],
      ["web", "start", "./node_modules/next/dist/bin/next"],
    ];
    for (const entry of cases) {
      const parts = wiredScriptParts(entry[0], entry[1]);
      assert.equal(parts.entry, entry[2]);
    }
  });

  it("tsx watch descendants run on the checked binary, not a PATH-selected node", { skip: watchSkipReason(), timeout: 120000 }, async () => {
    // Behavioral proof, offline: run the real wired tsx entry in watch mode
    // with a fake `node` earlier in PATH. The watched child reports its own
    // process.execPath on start and after a restart; both must be the
    // checked binary. If tsx ever resolved the child runtime through PATH,
    // the fake (exit 99) would break the run and no record would appear.
    const fixture = makeTemp("kady guard watch ");
    const recDir = makeTemp("kady guard rec ");
    const probe = path.join(fixture, "probe.ts");
    const record = path.join(recDir, "record.jsonl");
    fs.writeFileSync(
      probe,
      [
        "import fs from 'node:fs';",
        "fs.appendFileSync(process.env.KADY_WATCH_RECORD, JSON.stringify({",
        "  execPath: process.execPath,",
        "  version: process.version,",
        "}) + '\\n');",
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    const fakeDir = makeTemp("kady guard fakenode ");
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(fakeDir, "node.cmd"), "@echo off\r\necho FAKE-NODE\r\nexit /b 99\r\n");
    } else {
      const fake = path.join(fakeDir, "node");
      fs.writeFileSync(fake, "#!/bin/sh\necho FAKE-NODE >&2\nexit 99\n");
      fs.chmodSync(fake, 0o755);
    }
    const tsxCli = path.join(REPO_ROOT, "server", "node_modules", "tsx", "dist", "cli.mjs");
    const watcher = spawn(
      SUPPORTED_NODE,
      ["--import", GUARD, tsxCli, "watch", probe],
      {
        cwd: fixture,
        env: {
          ...process.env,
          PATH: fakeDir + path.delimiter + (process.env.PATH || ""),
          KADY_WATCH_RECORD: record,
        },
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    watcher.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    const readLines = () => {
      try {
        return fs.readFileSync(record, "utf-8").split("\n").filter((line) => line.length > 0);
      } catch (err) {
        return [];
      }
    };
    const waitForLines = (count, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (readLines().length >= count) return true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
      return false;
    };
    try {
      assert.ok(waitForLines(1, 45000), "watched child never started: " + stderr);
      fs.appendFileSync(probe, "\n// restart " + Date.now() + "\n");
      assert.ok(waitForLines(2, 45000), "watched child never restarted: " + stderr);
      const lines = readLines();
      assert.ok(lines.length >= 2);
      for (const line of lines) {
        const seen = JSON.parse(line);
        assert.equal(fs.realpathSync(seen.execPath), fs.realpathSync(SUPPORTED_NODE));
        assert.equal(checkNodeVersion(seen.version).ok, true);
      }
      assert.ok(!stderr.includes("FAKE-NODE"), "a PATH-selected node must never run: " + stderr);
    } finally {
      try {
        if (process.platform === "win32") watcher.kill("SIGKILL");
        else process.kill(-watcher.pid, "SIGKILL");
      } catch (err) {
        /* already gone */
      }
      await waitForExit(watcher, 15000).catch(() => undefined);
    }
  });
});

describe("guard rejects before the entry loads", () => {
  it(
    "bad runtime exits 1 with the policy error and never runs the entry",
    { skip: HOST_SUPPORTED ? "host Node passes the policy; rejection needs a rejected binary" : false },
    () => {
      const fixture = makeFixture();
      const record = path.join(fixture.root, "record.json");
      const result = runGuardSync(HOST_NODE, [fixture.cli, "should-never-run"], {
        cwd: fixture.root,
        env: { ...process.env, KADY_GUARD_FIXTURE_OUT: record },
      });
      assert.notEqual(result.status, 0);
      assert.ok(
        (result.stderr || "").includes("GHSA-xjj6-f33q-929c"),
        "expected policy error, got: " + result.stderr,
      );
      assert.equal(fs.existsSync(record), false, "entry must not run on a rejected runtime");
    },
  );

  it(
    "the wired tsx command refuses on a bad runtime",
    { skip: HOST_SUPPORTED ? "host Node passes the policy; rejection needs a rejected binary" : false },
    () => {
      const parts = wiredScriptParts("server", "start");
      const result = runGuardSync(HOST_NODE, [parts.entry, "--version"], { cwd: path.join(REPO_ROOT, "server") });
      assert.notEqual(result.status, 0);
      assert.ok((result.stderr || "").includes("GHSA-xjj6-f33q-929c"), "stderr=" + result.stderr);
    },
  );
});

describe("guard passes through on a supported runtime", () => {
  const skipReason = SUPPORTED_NODE
    ? false
    : "no supported Node (host rejected and KADY_VERIFY_NODE_BIN unset/invalid)";

  it("runs the entry with argv, env and exit code preserved", { skip: skipReason }, () => {
    const fixture = makeFixture();
    const record = path.join(fixture.root, "record.json");
    const result = runGuardSync(SUPPORTED_NODE, [fixture.cli, "hello world", "a&b"], {
      cwd: fixture.root,
      env: { ...process.env, KADY_GUARD_FIXTURE_OUT: record, KADY_GUARD_MARKER: "marker-123" },
    });
    assert.equal(result.status, 0, "stdout=" + result.stdout + " stderr=" + result.stderr);
    const seen = JSON.parse(fs.readFileSync(record, "utf-8"));
    assert.deepEqual(seen.argv, ["hello world", "a&b"]);
    assert.equal(seen.marker, "marker-123");
    assert.equal(fs.realpathSync(seen.execPath), fs.realpathSync(SUPPORTED_NODE));
    assert.equal(checkNodeVersion(seen.version).ok, true, "entry must report a supported runtime");
  });

  it("propagates nonzero exit codes", { skip: skipReason }, () => {
    const fixture = makeFixture();
    const result = runGuardSync(SUPPORTED_NODE, [fixture.cli], {
      cwd: fixture.root,
      env: { ...process.env, KADY_GUARD_EXIT: "42" },
    });
    assert.equal(result.status, 42);
  });

  it("runs from a path containing spaces", { skip: skipReason }, () => {
    const fixture = makeFixture();
    assert.ok(fixture.root.includes(" "), "fixture path must contain a space for this test");
    const record = path.join(fixture.root, "record.json");
    const result = runGuardSync(SUPPORTED_NODE, [fixture.cli], {
      cwd: fixture.root,
      env: { ...process.env, KADY_GUARD_FIXTURE_OUT: record },
    });
    assert.equal(result.status, 0, "stderr=" + result.stderr);
    assert.ok(fs.existsSync(record));
  });

  it("the wired tsx command runs on a good runtime", { skip: skipReason }, () => {
    const parts = wiredScriptParts("server", "start");
    const result = runGuardSync(SUPPORTED_NODE, [parts.entry, "--version"], {
      cwd: path.join(REPO_ROOT, "server"),
    });
    assert.equal(result.status, 0, "stderr=" + result.stderr);
    assert.ok((result.stdout || "").includes("tsx"), "stdout=" + result.stdout);
  });

  it("the wired next command runs on a good runtime", { skip: skipReason }, () => {
    const parts = wiredScriptParts("web", "dev");
    const result = runGuardSync(SUPPORTED_NODE, [parts.entry, "--version"], {
      cwd: path.join(REPO_ROOT, "web"),
    });
    assert.equal(result.status, 0, "stderr=" + result.stderr);
    assert.ok((result.stdout || "").toLowerCase().includes("next"), "stdout=" + result.stdout);
  });
});

describe("signals reach the service exactly once (POSIX)", () => {
  const posixOnly = process.platform === "win32" ? "process-group signals are POSIX-only" : false;
  const skipReason = posixOnly || (SUPPORTED_NODE ? false : "no supported Node (host rejected and KADY_VERIFY_NODE_BIN unset/invalid)");

  it("one broadcast group signal is delivered exactly once", { skip: skipReason }, async () => {
    const fixture = makeFixture();
    const child = spawn(
      SUPPORTED_NODE,
      ["--import", GUARD, fixture.cli],
      {
        cwd: fixture.root,
        env: { ...process.env, KADY_GUARD_FIXTURE_DIR: fixture.root, KADY_GUARD_MODE: "count" },
        detached: true,
        stdio: "ignore",
      },
    );
    try {
      assert.ok(waitForFile(path.join(fixture.root, "ready")), "service never started");
      // Launcher/terminal shape: signal the whole group. There is no
      // intermediary, so the service gets this one copy directly.
      process.kill(-child.pid, "SIGTERM");
      const end = await waitForExit(child);
      assert.equal(end.code, 0, "service must exit cleanly after one signal");
      assert.ok(waitForFile(path.join(fixture.root, "done")), "service never finished shutdown");
      assert.equal(fs.readFileSync(path.join(fixture.root, "count"), "utf-8").trim(), "1");
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (err) {
        /* already gone */
      }
    }
  });

  it("one PID-targeted signal is delivered exactly once (no orphan possible)", { skip: skipReason }, async () => {
    const fixture = makeFixture();
    const child = spawn(
      SUPPORTED_NODE,
      ["--import", GUARD, fixture.cli],
      {
        cwd: fixture.root,
        env: { ...process.env, KADY_GUARD_FIXTURE_DIR: fixture.root, KADY_GUARD_MODE: "count" },
        detached: true,
        stdio: "ignore",
      },
    );
    try {
      assert.ok(waitForFile(path.join(fixture.root, "ready")), "service never started");
      // npm's signal-manager and other supervisors signal the immediate child
      // pid. With the in-process guard that pid IS the service, so the
      // signal lands exactly once and nothing is left running.
      process.kill(child.pid, "SIGTERM");
      const end = await waitForExit(child);
      assert.equal(end.code, 0, "service must exit cleanly after one signal");
      assert.ok(waitForFile(path.join(fixture.root, "done")), "service never finished shutdown");
      assert.equal(fs.readFileSync(path.join(fixture.root, "count"), "utf-8").trim(), "1");
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (err) {
        /* already gone */
      }
    }
  });
});

describe("launcher wiring", () => {
  it("start.mjs refuses --check on a rejected runtime before any installs", () => {
    if (HOST_SUPPORTED) return; // supported hosts proceed into env/install steps; nothing to assert here
    const result = spawnSync(HOST_NODE, [path.join(REPO_ROOT, "start.mjs"), "--check"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 30000,
    });
    assert.notEqual(result.status, 0);
    const combined = (result.stdout || "") + (result.stderr || "");
    assert.ok(combined.includes("GHSA-xjj6-f33q-929c"), "expected policy error, got: " + combined);
  });

  it("start.mjs checks the runtime before installing dependencies", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "start.mjs"), "utf-8");
    assert.ok(source.includes("./node-policy.mjs"), "launcher must import the shared policy");
    const checkAt = source.indexOf("checkNode();");
    const installAt = source.indexOf("installBackendPackages();");
    assert.ok(checkAt !== -1 && installAt !== -1, "both call sites present");
    assert.ok(checkAt < installAt, "runtime check must precede dependency installation");
  });
});
