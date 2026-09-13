import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mintProjectId } from "../src/projects.ts";
import { cacheKeyForSource } from "../src/agent/skills-fetch.ts";
import {
  persistEnv,
  setCredentialEnvPathForTests,
} from "../src/api/credentials.ts";

let tmpEnv: string | null = null;

afterEach(() => {
  setCredentialEnvPathForTests(null);
  tmpEnv = null;
});

describe("Phase 1 CodeQL hardening", () => {
  it("caps unbounded slug input before the repeated-class regex", () => {
    const hostile = `${"a-".repeat(5000)}-end`;
    const t0 = Date.now();
    const key = cacheKeyForSource(hostile);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(key.length).toBeLessThan(64);
    // A long run of separators collapses the same as a short one.
    expect(cacheKeyForSource("a-----b").split("-")[0]).toBe(
      cacheKeyForSource("a-b").split("-")[0],
    );
  });

  it("mintProjectId bounds long names identically to their prefix", () => {
    const long = `${"x".repeat(500)}${"-".repeat(500)}tail`;
    const short = long.slice(0, 128);
    const idLong = mintProjectId(long);
    const idShort = mintProjectId(short);
    // Same capped prefix → same slug base (suffix differs by randomness).
    expect(idLong.split("-").slice(0, -1).join("-")).toBe(
      idShort.split("-").slice(0, -1).join("-"),
    );
    expect(idLong.length).toBeLessThan(64);
  });

  it("persistEnv round-trips a value ending in backslash + quote", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-cred-"));
    tmpEnv = path.join(dir, ".env");
    setCredentialEnvPathForTests(tmpEnv);
    const tricky = `ends-in-backslash\\ and "quote"`;
    persistEnv("KADY_T_TRICKY", tricky);
    const content = fs.readFileSync(tmpEnv, "utf-8");
    // The closing quote must survive: the line ends with a bare `"`.
    const line = content.split("\n").find((l) => l.startsWith("KADY_T_TRICKY="));
    expect(line).toBeTruthy();
    expect(line!.endsWith('"')).toBe(true);
    expect(line).toContain('\\\\');
    expect(line).toContain('\\"');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
