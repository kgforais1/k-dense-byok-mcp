/** A missing-context response must never be inserted into the document. */
export type LatexAssistDecision =
  | { status: "replacement"; replacement: string }
  | { status: "needs_context"; message: string };

export function parseLatexAssistDecision(text: string): LatexAssistDecision | null {
  const trimmed = text.trim();
  // FORK: delimit fences directly rather than backtracking across whitespace/body.
  const firstNewline = trimmed.indexOf("\n");
  const fenced = firstNewline >= 0 && trimmed.endsWith("```")
    && /^```(?:json)?\s*$/.test(trimmed.slice(0, firstNewline));
  try {
    const value = JSON.parse(fenced ? trimmed.slice(firstNewline + 1, -3) : trimmed);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.status === "replacement" && typeof value.replacement === "string"
      && Object.keys(value).every((key) => key === "status" || key === "replacement")) {
      return { status: "replacement", replacement: value.replacement };
    }
    if (value.status === "needs_context" && typeof value.message === "string"
      && value.message.trim() && value.message.length <= 2000
      && Object.keys(value).every((key) => key === "status" || key === "message")) {
      return { status: "needs_context", message: value.message.trim() };
    }
  } catch { /* malformed or partial responses cannot be applied */ }
  return null;
}
