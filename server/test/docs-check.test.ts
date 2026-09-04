import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const DOCS_CHECK_PATH = path.resolve(__dirname, "..", "..", "scripts", "docs-check.mjs");
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function runDocsCheck(cwd = REPO_ROOT) {
  const result = spawnSync("node", [DOCS_CHECK_PATH], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("scripts/docs-check.mjs", () => {
  it("passes against the current repository state", () => {
    const result = runDocsCheck();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("docs:check: ok");
  });

  it("passes against a clean checkout (only git-tracked files, plus untracked branch files)", () => {
    // A fresh clone has no gitignored runtime state (e.g. projects/). The
    // docs gate and the manifest must stay green there. Simulate by copying
    // `git ls-files` (tracked) + `git ls-files --others --exclude-standard`
    // (untracked, non-ignored) into a temp dir.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kady-clean-clone-"));
    try {
      const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" });
      const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      expect(tracked.status).toBe(0);
      expect(untracked.status).toBe(0);
      const NUL = String.fromCharCode(0);
      const files = [...tracked.stdout.split(NUL), ...untracked.stdout.split(NUL)].filter(Boolean);
      expect(files.length).toBeGreaterThan(0);
      for (const rel of files) {
        const dest = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(REPO_ROOT, rel), dest);
      }
      const result = runDocsCheck(tmp);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("docs:check: ok");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  describe("negative fixtures in a temp repo", () => {
    let tmp: string;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kady-docs-check-"));
    });

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    function writeFile(relPath, content) {
      const full = path.join(tmp, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }

    function runInTmp() {
      return runDocsCheck(tmp);
    }

    it("flags a broken relative link", () => {
      writeFile(
        "README.md",
        "# Root\n\n[broken](docs/missing.md)\n",
      );
      writeFile("docs/existing.md", "# Existing\n");
      const result = runInTmp();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("link target missing");
      expect(result.stderr).toContain("missing.md");
    });

    it("flags a missing fragment anchor", () => {
      writeFile(
        "README.md",
        "# Root\n\n[go](#no-such-heading)\n",
      );
      const result = runInTmp();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fragment #no-such-heading not found");
    });

    it("flags a missing fragment anchor in a markdown file outside scanned roots", () => {
      writeFile(
        "README.md",
        "# Root\n\n[server policy](server/AGENTS.md#no-such-section)\n",
      );
      writeFile("server/AGENTS.md", "# Server\n\n## Real Section\n");
      const result = runInTmp();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fragment #no-such-section not found");
      expect(result.stderr).toContain("server/AGENTS.md");
    });

    it("flags a malformed CLAUDE.md pointer (missing link)", () => {
      writeFile("CLAUDE.md", "# CLAUDE.md\nNo pointer here.\n");
      writeFile("AGENTS.md", "# AGENTS.md\n");
      const result = runInTmp();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "CLAUDE.md: must contain exactly one AGENTS.md pointer line, found 0",
      );
    });

    it("flags a CLAUDE.md with an unlisted policy bullet", () => {
      writeFile(
        "CLAUDE.md",
        [
          "# CLAUDE.md",
          "[`AGENTS.md`](AGENTS.md)",
          "",
          "Read and follow the canonical repository instructions at",
          "[`AGENTS.md`](AGENTS.md). If a scoped instruction file is closer to the",
          "area you are changing, read it first, then this file:",
          "",
          "- Never bypass review",
          "",
          "Do not add policy, commands, or invariants to this file. Update",
          "`AGENTS.md` (and the scoped file, if any) instead.",
        ].join("\n"),
      );
      writeFile("AGENTS.md", "# AGENTS.md\n");
      const result = runInTmp();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "CLAUDE.md: must not contain extra policy bullets (found '- Never bypass review')",
      );
    });

    it("flags a CLAUDE.md with extra policy headings", () => {
      writeFile(
        "CLAUDE.md",
        [
          "# CLAUDE.md",
          "[`AGENTS.md`](AGENTS.md)",
          "",
          "## Extra policy heading",
          "",
          "Do not add policy",
        ].join("\n"),
      );
      writeFile("AGENTS.md", "# AGENTS.md\n");
      const result = runInTmp();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "CLAUDE.md: must not contain extra policy headings",
      );
    });

    it("flags a plan in dev-docs/plans with status completed that is not in completed/", () => {
      writeFile(
        "dev-docs/plans/2026-01-01-wrong.md",
        "# Plan\n\nstatus: completed\n",
      );
      const result = runInTmp();
      expect(result.status).toBe(1);
      // rel() uses path.relative, which yields backslashes on Windows; normalize
      // so the assertion matches on every platform.
      const stderr = result.stderr.replace(/\\/g, "/");
      expect(stderr).toContain(
        "dev-docs/plans/2026-01-01-wrong.md: plan with status 'completed' must be under dev-docs/plans/completed/",
      );
    });

    it("flags a completed plan missing the required status marker", () => {
      writeFile(
        "dev-docs/plans/completed/2026-01-01-done.md",
        "# Plan\n\nstatus: proposed\n",
      );
      const result = runInTmp();
      expect(result.status).toBe(1);
      const stderr = result.stderr.replace(/\\/g, "/");
      expect(stderr).toContain(
        "dev-docs/plans/completed/2026-01-01-done.md: completed plan must have status 'completed' or 'Completed and merged...'",
      );
    });

    it("passes with a valid minimal repo layout", () => {
      writeFile("AGENTS.md", "# AGENTS.md\n");
      writeFile(
        "CLAUDE.md",
        [
          "# CLAUDE.md",
          "[`AGENTS.md`](AGENTS.md)",
          "",
          "Do not add policy, commands, or invariants to this file. Update",
          "`AGENTS.md` (and the scoped file, if any) instead.",
        ].join("\n"),
      );
      writeFile(
        "GEMINI.md",
        [
          "# GEMINI.md",
          "[`AGENTS.md`](AGENTS.md)",
          "",
          "Do not add policy, commands, or invariants to this file. Update",
          "`AGENTS.md` (and the scoped file, if any) instead.",
        ].join("\n"),
      );
      writeFile("README.md", "# README\n");
      writeFile("docs/valid.md", "# Valid\n[link](../AGENTS.md)\n");
      writeFile(
        "scripts/repo-manifest.json",
        JSON.stringify({
          categories: {
            "entry-point": "Entry points",
            "runtime-service": "Runtime services",
            "persistence-boundary": "Persistence boundaries",
            policy: "Policy files",
            verification: "Verification files",
            "developer-documentation": "Developer docs",
            "product-documentation": "Product docs",
            "release-record": "Release records",
          },
          entries: [
            {
              id: "agents",
              category: "policy",
              path: "AGENTS.md",
              name: "Root policy",
              description: "x",
            },
          ],
        }),
      );
      const result = runInTmp();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("docs:check: ok");
    });
  });

  describe("node CLI entry", () => {
    it("exits 0 on success", () => {
      const result = spawnSync("node", [DOCS_CHECK_PATH], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
    });
  });
});
