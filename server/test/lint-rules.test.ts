import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The backend lint config carries one rule that encodes a repository
 * invariant rather than a style preference, and an invariant nobody can trip
 * is not enforced — it is decoration. These tests lint synthetic sources
 * through the real config, so the rule is checked by its behaviour rather
 * than by its presence in the file.
 *
 * Synthetic rather than fixture files on disk: a fixture that violates the
 * rule would have to be excluded from the tree's own lint run, and an
 * exclusion is exactly the thing that silently stops holding.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");

const eslint = new ESLint({
  cwd: serverRoot,
  overrideConfigFile: path.join(serverRoot, "eslint.config.mjs"),
});

async function lint(source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, {
    // Linted *as* the file the rule is scoped to. The rule is not global —
    // it belongs to one function in one file — so a synthetic path outside
    // that scope would silently test nothing.
    filePath: path.join(serverRoot, "src/api/sessions.ts"),
  });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => m.message);
}

describe("prepareRun must not touch the HTTP reply", () => {
  it("rejects a reply write inside prepareRun", async () => {
    const messages = await lint(`
      export async function prepareRun(sessionId: string, reply: { code: (n: number) => void }) {
        reply.code(409);
        return sessionId;
      }
    `);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain("typed RunStartRejection");
  });

  it("rejects the other reply writers, not just .code", async () => {
    // `.send`, `.status` and `.raw` end the sharing the same way a `.code`
    // does, so the rule matches any member access rather than one name.
    for (const write of ["reply.send({})", "reply.status(500)", "reply.raw.end()"]) {
      const messages = await lint(`
        export async function prepareRun(reply: any) {
          ${write};
          return null;
        }
      `);
      expect(messages.length, write).toBeGreaterThan(0);
    }
  });

  it("rejects it when prepareRun is an arrow assigned to a const", async () => {
    // The rule names the function, so a refactor from declaration to
    // expression must not quietly drop the guard.
    const messages = await lint(`
      export const prepareRun = async (reply: { code: (n: number) => void }) => {
        reply.code(409);
        return null;
      };
    `);
    expect(messages.length).toBeGreaterThan(0);
  });

  // Greptile, on the first version of this rule: matching `reply.code(...)`
  // alone is bypassed by anyone who renames, aliases, destructures or
  // forwards the parameter. Each of those still couples `prepareRun` to
  // HTTP, and each has to get the reply in through the parameter list first
  // — so the guard sits on the signature and these are the forms it covers.
  it("rejects a reply that arrives under another name", async () => {
    for (const param of ["res", "response"]) {
      const messages = await lint(`
        export async function prepareRun(${param}: { code: (n: number) => void }) {
          ${param}.code(409);
          return null;
        }
      `);
      expect(messages.length, param).toBeGreaterThan(0);
    }
  });

  it("rejects a reply typed as FastifyReply whatever it is called", async () => {
    // The name is a convention; the type is the fact. This is the form that
    // catches an alias or a destructure, because either still has to be
    // typed to compile.
    const messages = await lint(`
      import type { FastifyReply } from "fastify";
      export async function prepareRun(sink: FastifyReply) {
        const target = sink;
        return target;
      }
    `);
    expect(messages.length).toBeGreaterThan(0);
  });

  it("rejects a destructured reply", async () => {
    const messages = await lint(`
      import type { FastifyReply } from "fastify";
      export async function prepareRun({ code }: FastifyReply) {
        code(409);
        return null;
      }
    `);
    expect(messages.length).toBeGreaterThan(0);
  });

  it("rejects handing the reply to a helper instead of using it", async () => {
    // No member access at all, which is exactly what the use-site-only
    // version of this rule missed.
    const messages = await lint(`
      import type { FastifyReply } from "fastify";
      declare function fail(r: FastifyReply): void;
      export async function prepareRun(reply: FastifyReply) {
        fail(reply);
        return null;
      }
    `);
    expect(messages.length).toBeGreaterThan(0);
  });

  it("rejects a FastifyReply written as an alias, qualified, or inline", async () => {
    // Four different AST nodes for the same type. The first version of the
    // rule knew only the first, which a reviewer demonstrated by getting a
    // reply in under each of the other three.
    const forms = [
      'import type { FastifyReply } from "fastify";\nexport async function prepareRun(sink: FastifyReply) { return sink; }',
      'import type { FastifyReply as Reply } from "fastify";\nexport async function prepareRun(sink: Reply) { return sink; }',
      'import type * as fastify from "fastify";\nexport async function prepareRun(sink: fastify.FastifyReply) { return sink; }',
      'export async function prepareRun(sink: import("fastify").FastifyReply) { return sink; }',
    ];
    for (const form of forms) {
      expect((await lint(form)).length, form).toBeGreaterThan(0);
    }
  });

  it("rejects the const-assigned function expression, not just the arrow", async () => {
    // The form the config's own comment used to omit while calling itself
    // "the two shapes".
    const messages = await lint(`
      export const prepareRun = async function (reply: { code: (n: number) => void }) {
        return reply;
      };
    `);
    expect(messages.length).toBeGreaterThan(0);
  });

  // The two halves of the rule — "a parameter that says reply" and "a member
  // access on a reply" — both fire on most violations, so a test that trips
  // both cannot tell which is doing the work. A reviewer showed that deleting
  // either half whole left all nine of the original tests green. These two
  // isolate them.
  it("rejects a reply-named parameter that is never used", async () => {
    const messages = await lint(`
      export async function prepareRun(reply: string) {
        return reply;
      }
    `);
    expect(messages).toHaveLength(1);
  });

  it("rejects a reply reached from module scope with clean parameters", async () => {
    const messages = await lint(`
      declare const reply: { code: (n: number) => void };
      export async function prepareRun(sessionId: string) {
        reply.code(409);
        return sessionId;
      }
    `);
    expect(messages).toHaveLength(1);
  });

  it("allows a typed rejection, which is the shape this exists to protect", async () => {
    const messages = await lint(`
      export async function prepareRun(sessionId: string) {
        if (!sessionId) {
          return { failure: { statusCode: 404, body: { detail: "No such session" } } };
        }
        return { sessionId };
      }
    `);
    expect(messages).toEqual([]);
  });

  it("allows a reply write in a route handler, which is where it belongs", async () => {
    // The invariant is about `prepareRun`, not about replies. A rule that
    // fired here would be deleted within a week.
    const messages = await lint(`
      export async function startRun(reply: { code: (n: number) => void }) {
        reply.code(409);
        return null;
      }
    `);
    expect(messages).toEqual([]);
  });
});

describe("the rule's anchor", () => {
  it("still has a prepareRun to guard", async () => {
    // The selectors key on the function name, and the rule is scoped to the
    // file. Renaming or moving `prepareRun` would leave the whole guard
    // matching nothing, with every test still green and lint still clean —
    // silently losing the guard is the exact failure class this PR exists to
    // prevent, so it cannot be allowed to happen quietly here either.
    const source = await readFile(
      path.join(serverRoot, "src/api/sessions.ts"),
      "utf8",
    );
    expect(
      /\basync function prepareRun\b/.test(source),
      "prepareRun was renamed or moved; update PREPARE_RUN_FORMS and the files scope in server/eslint.config.mjs, or the invariant is no longer enforced",
    ).toBe(true);
  });
});
