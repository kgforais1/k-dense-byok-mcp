import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyEnvFile } from "../../env-file.mjs";
import { mintProjectId } from "../src/projects.ts";
import { cacheKeyForSource } from "../src/agent/skills-fetch.ts";
import {
  persistEnv,
  setCredentialEnvPathForTests,
} from "../src/api/credentials.ts";

let tmpDir: string | null = null;

afterEach(() => {
  setCredentialEnvPathForTests(null);
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function freshEnvFile(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-cred-"));
  const file = path.join(tmpDir, ".env");
  setCredentialEnvPathForTests(file);
  return file;
}

describe("Phase 1 CodeQL hardening", () => {
  it("caps slug input before the repeated-class regex", () => {
    // A 10k-char hostile input must collapse to the same key as its capped
    // prefix: the regex never sees more than the cap, which is the whole
    // ReDoS protection (no wall-clock assertion — those flake on busy CI).
    const hostile = `${"a-".repeat(5000)}-end`;
    const capped = hostile.slice(0, 256);
    // The digest suffix hashes the full source, so compare the slug prefix:
    // the regex must never see more than the cap.
    const slugOf = (key: string) => key.slice(0, -17);
    expect(slugOf(cacheKeyForSource(hostile))).toBe(slugOf(cacheKeyForSource(capped)));
    expect(cacheKeyForSource(hostile).length).toBeLessThan(64);
    // A long run of separators collapses the same as a short one.
    expect(slugOf(cacheKeyForSource("a-----b"))).toBe(slugOf(cacheKeyForSource("a-b")));
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

  it("persistEnv round-trips through the real loader", () => {
    const file = freshEnvFile();
    // Values the writer quotes: spaces, #, and a trailing backslash. The
    // sole reader is `applyEnvFile`, which strips quotes without unescaping,
    // so what it reads back must equal what was written.
    for (const tricky of ["with space", "trailing\\", "C:\\my path\\key", "hash#tag"]) {
      persistEnv("KADY_T_TRICKY", tricky);
      delete process.env.KADY_T_TRICKY;
      expect(applyEnvFile(file, { override: true })).toBe(true);
      expect(process.env.KADY_T_TRICKY).toBe(tricky);
      delete process.env.KADY_T_TRICKY;
    }
    expect(fs.readFileSync(file, "utf-8")).toContain("KADY_T_TRICKY=");
  });
});
