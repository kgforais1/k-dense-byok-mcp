/**
 * HTTP-level tests for sandbox routes inside the rate-limited encapsulated
 * scope (server/src/index.ts: sandboxRateLimitedScope). Two invariants that
 * depend on the scope inheriting the root app's onRequest hook and catch-all
 * content-type parser:
 *   1. X-Project-Id scopes sandbox file operations to the named project's
 *      sandbox (AsyncLocalStorage → currentProjectId() → safePath()).
 *   2. PUT /sandbox/file accepts an application/octet-stream body as a raw
 *      Buffer (the root addContentTypeParser("*") registration).
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, resolvePaths } from "../src/projects.ts";

const app = await buildApp();

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  // Writes to a non-default project must 404 unless the project exists, so
  // create it the way the API would (and recreate it per test — the hook
  // deliberately refuses to resurrect deleted projects).
  createProject({ name: "proj-a", projectId: "proj-a" });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("sandbox routes inside the rate-limited scope", () => {
  it("scopes PUT /sandbox/file to the project named by X-Project-Id", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/sandbox/file?path=user_data/notes/scope-test.txt",
      headers: { "content-type": "application/octet-stream", "x-project-id": "proj-a" },
      payload: Buffer.from("scoped body", "utf8"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: "user_data/notes/scope-test.txt", size: 11 });

    // The write landed in proj-a's sandbox, not the default project's.
    const scopedPath = path.join(resolvePaths("proj-a").sandbox, "user_data/notes/scope-test.txt");
    expect(fs.readFileSync(scopedPath, "utf8")).toBe("scoped body");
    const defaultPath = path.join(resolvePaths("default").sandbox, "user_data/notes/scope-test.txt");
    expect(fs.existsSync(defaultPath)).toBe(false);
  });

  it("accepts an application/octet-stream body as a raw Buffer", async () => {
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42]);
    const res = await app.inject({
      method: "PUT",
      url: "/sandbox/file?path=binary.bin",
      headers: { "content-type": "application/octet-stream" },
      payload: bytes,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: "binary.bin", size: bytes.length });

    const onDisk = fs.readFileSync(path.join(resolvePaths("default").sandbox, "binary.bin"));
    expect(onDisk.equals(bytes)).toBe(true);
  });

  it("does not cross project boundaries on read-back", async () => {
    await app.inject({
      method: "PUT",
      url: "/sandbox/file?path=only-in-a.txt",
      headers: { "content-type": "text/plain", "x-project-id": "proj-a" },
      payload: "a",
    });
    const resDefault = await app.inject({ method: "GET", url: "/sandbox/file?path=only-in-a.txt" });
    expect(resDefault.statusCode).toBe(404);
    const resScoped = await app.inject({
      method: "GET",
      url: "/sandbox/file?path=only-in-a.txt",
      headers: { "x-project-id": "proj-a" },
    });
    expect(resScoped.statusCode).toBe(200);
    expect(resScoped.body).toBe("a");
  });
});
