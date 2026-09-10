/**
 * Reproducibility export: reconstruct a session's work from its Pi JSONL file.
 *
 * Scientists need to see — and re-run — exactly what the agent did. The Pi
 * session log records every user prompt, assistant message, tool call (name +
 * arguments) and tool result, so we can replay it as either:
 *   - a runnable shell script (`sh`): every `bash` command in order, with the
 *     surrounding prompts/notes as comments; or
 *   - a markdown lab notebook (`md`): the full narrative — prompts, reasoning,
 *     each command and its (truncated) output, and the final answers.
 */
import fs from "node:fs";
import path from "node:path";
import type { ProjectPaths } from "../projects.ts";
import { relativizeSandboxPaths } from "./events.ts";

export interface ToolCallPart {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}
export interface ToolResultPart {
  type: "toolResult";
  toolCallId: string;
  toolName?: string;
  content?: {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }[];
  details?: unknown;
  isError?: boolean;
}
export interface TextPart {
  type: "text";
  text: string;
}
export interface ThinkingPart {
  type: "thinking";
  thinking: string;
}
type ContentPart = ToolCallPart | ToolResultPart | TextPart | ThinkingPart | { type: string };

export interface MessageRow {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult" | string;
    content: ContentPart[];
    // Pi writes tool results as whole messages (role "toolResult") with the
    // linkage fields at the message level rather than as a content part.
    toolCallId?: string;
    toolName?: string;
    details?: unknown;
    isError?: boolean;
    timestamp?: number;
  };
}

/** Locate the JSONL file for a session id under the project's sessions dir. */
/**
 * Whether a session id is safe to interpolate into a filename.
 *
 * The shape is deliberately narrower than "no separators": a leading dot is
 * rejected too, so neither `..` nor a hidden file can be addressed. Exported
 * because every caller that builds a path from a client-supplied id has to
 * apply it *before* touching the filesystem — `deleteSession` reaches a path
 * without going through `findSessionFile` and would otherwise be the hole.
 */
export function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) && !sessionId.includes("..");
}

/**
 * Every transcript in `paths.sessionsDir` whose *name* could be `sessionId`'s.
 *
 * Pi names a transcript `${timestamp}_${id}.jsonl` and finds it again by the
 * suffix `_${id}.jsonl` (pi-agent-core `harness/session/jsonl/repo.js`). The
 * separator is what makes that safe, and it is matched here for the same
 * reason: a bare `endsWith(`${id}.jsonl`)` lets the id `23` match
 * `..._123.jsonl` and hand back a different session's transcript. The exact
 * name is accepted too, because a session written directly as `<id>.jsonl` is
 * still that session's file.
 *
 * More than one can match — a stray `23.jsonl` sitting beside the real
 * `<timestamp>_23.jsonl` — which is why this returns all of them and lets the
 * caller decide. Deletion has to read each one's header rather than trust the
 * first name it sees.
 */
export function sessionFileCandidates(paths: ProjectPaths, sessionId: string): string[] {
  if (!isSafeSessionId(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
  if (!fs.existsSync(paths.sessionsDir)) return [];
  return fs
    .readdirSync(paths.sessionsDir)
    .filter((f) => f === `${sessionId}.jsonl` || f.endsWith(`_${sessionId}.jsonl`))
    .map((f) => path.join(paths.sessionsDir, f));
}

export function findSessionFile(paths: ProjectPaths, sessionId: string): string | null {
  return sessionFileCandidates(paths, sessionId)[0] ?? null;
}

export function readRows(file: string): MessageRow[] {
  const rows: MessageRow[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === "message" && obj.message) rows.push(obj as MessageRow);
    } catch {
      /* skip malformed line */
    }
  }
  return rows;
}

export function textOf(content: ContentPart[]): string {
  return (content ?? [])
    .filter((c): c is TextPart => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function resultText(parts: ToolResultPart["content"]): string {
  if (!parts) return "";
  const text = parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
  const images = parts.filter((p) => p.type === "image").length;
  if (!images) return text;
  const note = `[${images} image attachment${images > 1 ? "s" : ""}]`;
  return text ? `${text}\n${note}` : note;
}

/** Index every tool result by call id. Pi stores results as whole messages
 *  (role "toolResult", linkage at the message level); older logs nested them
 *  as content parts, so both shapes are scanned. */
export function indexToolResults(rows: MessageRow[]): Map<string, ToolResultPart> {
  const byId = new Map<string, ToolResultPart>();
  for (const row of rows) {
    const m = row.message;
    if (m.role === "toolResult" && m.toolCallId) {
      byId.set(m.toolCallId, {
        type: "toolResult",
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        content: m.content as ToolResultPart["content"],
        details: m.details,
        isError: m.isError,
      });
      continue;
    }
    for (const part of m.content ?? []) {
      if (part.type === "toolResult") {
        const r = part as ToolResultPart;
        byId.set(r.toolCallId, r);
      }
    }
  }
  return byId;
}

/** Quote a command for embedding as a comment without breaking lines. */
function asComment(s: string): string {
  return s
    .split("\n")
    .map((l) => `# ${l}`)
    .join("\n");
}

/**
 * Build a runnable bash script from the session's `bash` tool calls. Non-bash
 * tool calls (read/write/edit) are noted as comments so the script stays a
 * faithful, human-auditable record rather than silently dropping steps.
 */
export function toShellScript(file: string, sessionId: string, sandboxRoot = ""): string {
  const rel = (s: string) => relativizeSandboxPaths(s, sandboxRoot);
  const rows = readRows(file);
  const out: string[] = [
    "#!/usr/bin/env bash",
    "# ---------------------------------------------------------------------------",
    "# Reproducibility export — K-Dense BYOK",
    `# Session: ${sessionId}`,
    "# Re-runs every shell command the agent executed, in order. Review before",
    "# running: commands ran inside the project sandbox and may assume its files.",
    "# ---------------------------------------------------------------------------",
    "set -euo pipefail",
    "",
  ];
  let stepCount = 0;
  for (const row of rows) {
    const { role, content } = row.message;
    if (role === "user") {
      const t = textOf(content);
      if (t) out.push("", asComment(`PROMPT: ${t}`), "");
      continue;
    }
    if (role !== "assistant") continue;
    for (const part of content) {
      if (part.type === "toolCall") {
        const call = part as ToolCallPart;
        if (call.name === "bash" && call.arguments && typeof call.arguments.command === "string") {
          stepCount++;
          out.push(`# [step ${stepCount}]`, rel(String(call.arguments.command)), "");
        } else {
          const summary = call.arguments
            ? JSON.stringify(relativizeSandboxPaths(call.arguments, sandboxRoot))
            : "";
          out.push(asComment(`(non-shell tool: ${call.name} ${summary})`), "");
        }
      }
    }
  }
  if (stepCount === 0) {
    out.push(asComment("No shell commands were run in this session."));
  }
  return out.join("\n") + "\n";
}

/** Build a markdown "lab notebook" of the full session: prompts, reasoning,
 *  commands, outputs, and final answers. */
export function toNotebook(file: string, sessionId: string, sandboxRoot = ""): string {
  const rel = (s: string) => relativizeSandboxPaths(s, sandboxRoot);
  const rows = readRows(file);
  // Index tool results by call id so we can show output beneath each command.
  const resultsById = indexToolResults(rows);

  const out: string[] = [
    "# Lab Notebook",
    "",
    `_Session \`${sessionId}\` — reproducible record exported from K-Dense BYOK._`,
    "",
    "---",
    "",
  ];
  let turn = 0;
  for (const row of rows) {
    const { role, content } = row.message;
    if (role === "user") {
      const t = textOf(content);
      if (!t) continue;
      turn++;
      out.push(`## ${turn}. Prompt`, "", t, "");
      continue;
    }
    if (role !== "assistant") continue;

    for (const part of content) {
      if (part.type === "thinking") {
        const think = (part as ThinkingPart).thinking?.trim();
        if (think) {
          out.push("<details><summary>Reasoning</summary>", "", "> " + think.replace(/\n/g, "\n> "), "", "</details>", "");
        }
      } else if (part.type === "toolCall") {
        const call = part as ToolCallPart;
        const result = resultsById.get(call.id);
        if (call.name === "bash" && call.arguments?.command) {
          out.push("**Command**", "", "```bash", rel(String(call.arguments.command)), "```", "");
        } else {
          out.push(`**Tool: \`${call.name}\`**`, "", "```json", JSON.stringify(relativizeSandboxPaths(call.arguments ?? {}, sandboxRoot), null, 2), "```", "");
        }
        if (result) {
          const text = rel(resultText(result.content));
          if (text) {
            const label = result.isError ? "Error" : "Output";
            const clipped = text.length > 4000 ? text.slice(0, 4000) + "\n…(truncated)" : text;
            out.push(`**${label}**`, "", "```", clipped, "```", "");
          }
        }
      } else if (part.type === "text") {
        const t = (part as TextPart).text?.trim();
        if (t) out.push(t, "");
      }
    }
  }
  return out.join("\n") + "\n";
}
