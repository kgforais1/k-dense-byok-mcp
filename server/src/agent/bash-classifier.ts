/**
 * Raw-data guard: pure classification of file-tool paths and shell commands.
 *
 * Two questions, answered without touching the filesystem:
 *
 *   1. Does this call MUTATE a protected path (default `user_data/**`)?
 *      → hard block, for the lead agent and background specialists alike.
 *   2. Is this shell command DESTRUCTIVE elsewhere (`rm -rf`, `git clean -f`,
 *      `find … -delete`, …)? → the lead asks the user; a child is blocked.
 *
 * This is a heuristic tokenizer, not a shell parser, and deliberately biased
 * toward flagging: a false positive costs the model one retry with a clearer
 * command, a false negative deletes someone's raw data. It is defense in
 * depth, not a security boundary (see docs/limitations.md).
 *
 * `server/pi-packages/kady-guard/classifier.ts` is a byte-identical copy
 * (packages are loaded standalone by child pi processes); a parity test keeps
 * them in step.
 */

export type BashVerdict =
  | { kind: "allow" }
  | { kind: "protected"; path: string; glob: string; detail: string }
  | { kind: "destructive"; detail: string };

export interface ClassifyOptions {
  /** Sandbox-relative globs (`user_data/**`, `raw/*.csv`). */
  protectedGlobs: readonly string[];
  /** Absolute sandbox root, to relativize absolute paths in commands. */
  sandboxRoot?: string;
}

function escapeSegment(seg: string): string {
  let out = "";
  for (const ch of seg) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if (/[.+^${}()|[\]\\]/.test(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

/**
 * Minimal glob → RegExp over sandbox-relative paths: `**` spans segments,
 * `*` stays within one, `?` is one char. `a/**` also matches `a` itself
 * (deleting the directory is a mutation), and a glob with no wildcard at all
 * protects its whole subtree (`user_data` ≡ `user_data/**`).
 */
export function globToRegExp(glob: string): RegExp {
  let normalized = normalizeRel(glob) ?? "";
  if (normalized && !/[*?]/.test(normalized)) normalized += "/**";
  const segs = normalized.split("/").filter(Boolean);
  let re = "";
  let joinWithoutSlash = false;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === "**") {
      if (last) re += re ? "(?:/.*)?" : ".*";
      else {
        re += re ? "/(?:[^/]+/)*" : "(?:[^/]+/)*";
        joinWithoutSlash = true;
      }
      continue;
    }
    if (re && !joinWithoutSlash) re += "/";
    joinWithoutSlash = false;
    re += escapeSegment(seg);
  }
  return new RegExp(`^${re}$`);
}

/**
 * Strip `./`, leading and trailing `/`; collapse `.` and `..`. Returns null
 * when `..` climbs above the root (outside the sandbox).
 */
export function normalizeRel(p: string): string | null {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

/** Resolve a command token against a sandbox-relative cwd; absolute paths are
 *  relativized against `sandboxRoot`. Outside the sandbox → null. */
export function resolveSandboxPath(
  token: string,
  cwd: string,
  sandboxRoot?: string,
): string | null {
  let value = stripQuotes(token);
  if (!value || value.startsWith("~") || value.startsWith("$")) return null;
  // FORK (upstream merge): normalize Windows separators and drive letters up
  // front. Without this a `C:\…` absolute path never enters the absolute
  // branch below, falls through to the relative branch, misses the sandbox
  // root, and returns null (allow) — so on Windows every absolute tool path
  // silently bypassed the guard. Drive comparison is case-insensitive
  // (`C:/` ≡ `c:/`); POSIX comparison stays case-sensitive.
  value = value.replace(/\\/g, "/");
  const valueDrive = /^[A-Za-z]:\//.test(value);
  if (value.startsWith("/") || valueDrive) {
    if (!sandboxRoot) return null;
    const root = sandboxRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    const ci = valueDrive || /^[A-Za-z]:\//.test(root);
    const same = (a: string, b: string) => (ci ? a.toLowerCase() === b.toLowerCase() : a === b);
    const starts = (a: string, b: string) =>
      ci ? a.toLowerCase().startsWith(b.toLowerCase()) : a.startsWith(b);
    if (value.replace(/\/+$/, "").length === root.length) {
      if (!same(value.replace(/\/+$/, ""), root)) return null;
      return "";
    }
    if (!starts(value, `${root}/`)) return null;
    value = value.slice(root.length + 1);
    return normalizeRel(value);
  }
  return normalizeRel(cwd ? `${cwd}/${value}` : value);
}

export function matchProtected(rel: string, globs: readonly string[]): string | null {
  const normalized = normalizeRel(rel);
  if (normalized === null) return null;
  for (const glob of globs) {
    if (!glob.trim()) continue;
    if (globToRegExp(glob).test(normalized)) return glob;
  }
  return null;
}

function stripQuotes(token: string): string {
  if (token.length >= 3 && token.startsWith("$'") && token.endsWith("'")) return token.slice(2, -1);
  if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
    return token.slice(1, -1);
  }
  return token;
}

/** Shell-ish tokenizer: honours quotes, splits on whitespace, keeps operators. */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  const push = () => {
    if (current) tokens.push(current);
    current = "";
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    if (ch === ">" ) {
      push();
      if (segment[i + 1] === ">") {
        tokens.push(">>");
        i++;
      } else tokens.push(">");
      continue;
    }
    current += ch;
  }
  push();
  return tokens;
}

/** Split on `;`, `&&`, `||`, `|` and newlines, outside quotes. */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === "|" || ch === "&") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** Commands whose path arguments are mutated in place. */
const MUTATING = new Set([
  "rm", "rmdir", "mv", "shred", "truncate", "unlink", "chmod", "chown", "chgrp",
  "tee", "install", "ln", "mkfifo", "touch",
]);
const ENV_WRAPPERS = new Set(["sudo", "env", "nice", "nohup", "time", "command", "exec"]);
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const CODE_INTERPRETERS = new Set(["python", "python3", "node", "ruby", "perl"]);
/** Targets whose recursive removal is routine, not destructive. */
const BENIGN_RM_TARGETS = [
  /^(\/tmp|tmp|\.tmp|\.cache|\.venv|venv|node_modules|__pycache__|\.pytest_cache|\.mypy_cache|\.ipynb_checkpoints|dist|build|\.ruff_cache)(\/|$)/,
];

function isFlag(token: string): boolean {
  return token.startsWith("-") && token !== "-";
}

function unwrap(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && (ENV_WRAPPERS.has(tokens[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) {
    i++;
    // `sudo -u x`, `env -i`: skip flags following a wrapper
    while (i < tokens.length && isFlag(tokens[i])) {
      const flag = tokens[i++];
      if ((flag === "-u" || flag === "--user" || flag === "-g" || flag === "--group") && i < tokens.length) i++;
    }
  }
  return tokens.slice(i);
}

/** Extract balanced `$(...)` payloads plus backtick payloads, including nesting. */
function commandSubstitutions(command: string): string[] {
  const payloads: string[] = [];
  for (let i = 0; i < command.length; i++) {
    if (command[i] === "`") {
      const end = command.indexOf("`", i + 1);
      if (end >= 0) {
        payloads.push(command.slice(i + 1, end));
        i = end;
      }
      continue;
    }
    if (command[i] !== "$" || command[i + 1] !== "(") continue;
    let nesting = 1;
    let quote: string | null = null;
    for (let j = i + 2; j < command.length; j++) {
      const ch = command[j];
      if (quote) {
        if (ch === quote && command[j - 1] !== "\\") quote = null;
        continue;
      }
      if (ch === "\"" || ch === "'") quote = ch;
      else if (ch === "(") nesting++;
      else if (ch === ")" && --nesting === 0) {
        payloads.push(command.slice(i + 2, j));
        i = j;
        break;
      }
    }
  }
  return payloads;
}

/**
 * Classify one shell command. Returns the first protected-path mutation, else
 * the first destructive command, else allow.
 */
// FORK (upstream merge): complexity 73 over the 62 ceiling. The classifier
// table grew upstream; keep the byte-parity copy in sync (see test).
export function classifyBashCommand(command: string, opts: ClassifyOptions): BashVerdict {
  return classifyBashCommandAt(command, opts, "", 0);
}

// eslint-disable-next-line complexity
function classifyBashCommandAt(command: string, opts: ClassifyOptions, initialCwd: string, depth: number): BashVerdict {
  const globs = opts.protectedGlobs;
  let cwd = initialCwd;
  let destructive: BashVerdict | null = null;
  // FORK: wrappers and command substitutions must not bypass protected-path policy.
  if (depth < 4) {
    for (const payload of commandSubstitutions(command)) {
      const nested = classifyBashCommandAt(payload, opts, initialCwd, depth + 1);
      if (nested.kind !== "allow") return nested;
    }
  }
  const protectedHit = (token: string): { rel: string; glob: string } | null => {
    const candidate = token.replace(/^\$\(+/, "").replace(/\)+$/, "");
    const rel = resolveSandboxPath(candidate, cwd, opts.sandboxRoot);
    if (rel === null) return null;
    const glob = matchProtected(rel, globs);
    return glob ? { rel, glob } : null;
  };

  for (const segment of splitSegments(command)) {
    const raw = tokenize(segment);
    if (raw.length === 0) continue;

    // Redirections into a protected path.
    for (let i = 0; i < raw.length - 1; i++) {
      if (raw[i] === ">" || raw[i] === ">>") {
        const hit = protectedHit(raw[i + 1]);
        if (hit) {
          return { kind: "protected", path: hit.rel, glob: hit.glob, detail: `redirect ${raw[i]} ${hit.rel}` };
        }
      }
    }

    const tokens = unwrap(raw.filter((t) => t !== ">" && t !== ">>"));
    if (tokens.length === 0) continue;
    const cmd = (stripQuotes(tokens[0]).split("/").pop() ?? tokens[0]).replace(/\.exe$/i, "");
    const args = tokens.slice(1);
    const pathArgs = args.filter((a) => !isFlag(a));

    if (depth < 4 && SHELL_INTERPRETERS.has(cmd)) {
      const commandIndex = args.findIndex((arg) => arg === "--command" || (/^-[^-]*c/.test(arg) && !arg.includes("=")));
      const payload = commandIndex >= 0 ? stripQuotes(args[commandIndex + 1] ?? "") : "";
      if (payload) {
        const nested = classifyBashCommandAt(payload, opts, cwd, depth + 1);
        if (nested.kind !== "allow") return nested;
      }
    }

    if (CODE_INTERPRETERS.has(cmd)) {
      const codeIndex = args.findIndex((arg) => arg === "-c" || arg === "-e" || arg === "--eval");
      const code = codeIndex >= 0 ? stripQuotes(args[codeIndex + 1] ?? "") : "";
      const mutates = /\b(?:write|write_text|write_bytes|writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync|rmtree|remove|rename|replace|truncate|chmod|chown)\s*\(/.test(code)
        || /\bopen\s*\([^)]*,\s*["'][wax+]/.test(code);
      if (code && mutates) {
        for (const match of code.matchAll(/(["'])(.*?)\1/g)) {
          const hit = protectedHit(match[2]);
          if (hit) return { kind: "protected", path: hit.rel, glob: hit.glob, detail: `${cmd} inline mutation of ${hit.rel}` };
        }
      }
      if (/\b(?:system|popen|exec|spawn|run)\s*\(/.test(code)) {
        for (const match of code.matchAll(/(["'])(.*?)\1/g)) {
          const nested = classifyBashCommandAt(match[2], opts, cwd, depth + 1);
          if (nested.kind !== "allow") return nested;
        }
      }
    }

    if (depth < 4 && cmd === "eval") {
      const nested = classifyBashCommandAt(args.map(stripQuotes).join(" "), opts, cwd, depth + 1);
      if (nested.kind !== "allow") return nested;
    }

    if (cmd === "cd") {
      const target = pathArgs[0];
      if (!target) cwd = "";
      else {
        const resolved = resolveSandboxPath(target, cwd, opts.sandboxRoot);
        cwd = resolved ?? cwd;
      }
      continue;
    }

    const checkAll = (label: string): BashVerdict | null => {
      for (const a of pathArgs) {
        const hit = protectedHit(a);
        if (hit) return { kind: "protected", path: hit.rel, glob: hit.glob, detail: `${label} ${hit.rel}` };
      }
      return null;
    };

    if (MUTATING.has(cmd)) {
      const hit = checkAll(cmd);
      if (hit) return hit;
    }
    if (cmd === "cp" || cmd === "rsync" || cmd === "mv" || cmd === "install") {
      // Destination (last path arg) is written; `mv` also removes its sources.
      const dest = pathArgs[pathArgs.length - 1];
      if (dest) {
        const hit = protectedHit(dest);
        if (hit) return { kind: "protected", path: hit.rel, glob: hit.glob, detail: `${cmd} into ${hit.rel}` };
      }
    }
    if ((cmd === "sed" || cmd === "perl") && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === "--in-place")) {
      const hit = checkAll(`${cmd} -i`);
      if (hit) return hit;
    }
    if (cmd === "dd") {
      const of = args.find((a) => a.startsWith("of="));
      if (of) {
        const hit = protectedHit(of.slice(3));
        if (hit) return { kind: "protected", path: hit.rel, glob: hit.glob, detail: `dd of=${hit.rel}` };
      }
      if (!destructive) destructive = { kind: "destructive", detail: "dd writes raw blocks" };
    }
    if (cmd === "find" && (args.includes("-delete") || (args.includes("-exec") && args.some((a) => a === "rm")))) {
      const hit = checkAll("find -delete under");
      if (hit) return hit;
      if (!destructive) destructive = { kind: "destructive", detail: `${segment.trim()}` };
    }
    if (cmd === "xargs" && args.some((a) => stripQuotes(a) === "rm" || stripQuotes(a) === "shred")) {
      const hit = checkAll("xargs rm");
      if (hit) return hit;
      if (!destructive) destructive = { kind: "destructive", detail: `${segment.trim()}` };
    }
    if (cmd === "git") {
      const sub = args.find((a) => !isFlag(a));
      const flags = args.filter(isFlag);
      const cwdProtected = cwd ? matchProtected(cwd, globs) : null;
      if (sub === "clean" && flags.some((f) => /^-[a-zA-Z]*f/.test(f) || f === "--force")) {
        if (cwdProtected) return { kind: "protected", path: cwd, glob: cwdProtected, detail: "git clean inside protected path" };
        if (!destructive) destructive = { kind: "destructive", detail: segment.trim() };
      }
      if (sub === "reset" && flags.includes("--hard")) {
        if (!destructive) destructive = { kind: "destructive", detail: segment.trim() };
      }
      if (sub === "checkout" && (args.includes("--") || pathArgs.includes(".")) && !args.includes("-b")) {
        if (!destructive) destructive = { kind: "destructive", detail: segment.trim() };
      }
      if (sub === "rm") {
        const hit = checkAll("git rm");
        if (hit) return hit;
      }
    }
    if (cmd === "rm" || cmd === "rmdir" || cmd === "shred" || cmd === "unlink") {
      const recursive = cmd === "rm" && args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
      const forced = cmd === "rm" && args.some((a) => /^-[a-zA-Z]*f/.test(a) || a === "--force");
      const targets = pathArgs.map((a) => resolveSandboxPath(a, cwd, opts.sandboxRoot) ?? stripQuotes(a));
      const benign = targets.length > 0 && targets.every((t) => BENIGN_RM_TARGETS.some((re) => re.test(t)));
      if (cmd === "shred" || (recursive && (forced || pathArgs.length > 0) && !benign) || (cmd === "rm" && pathArgs.some((a) => /[*?]/.test(a) && !benign))) {
        if (!destructive) destructive = { kind: "destructive", detail: segment.trim() };
      }
    }
    if (cmd === "truncate" && args.some((a) => a === "-s" || a.startsWith("--size"))) {
      if (!destructive) destructive = { kind: "destructive", detail: segment.trim() };
    }
  }
  return destructive ?? { kind: "allow" };
}

/** `write`/`edit`: is the target under a protected glob? */
export function classifyFilePath(
  filePath: string,
  opts: ClassifyOptions,
): { kind: "allow" } | { kind: "protected"; path: string; glob: string } {
  const rel = resolveSandboxPath(filePath, "", opts.sandboxRoot);
  if (rel === null) return { kind: "allow" };
  const glob = matchProtected(rel, opts.protectedGlobs);
  return glob ? { kind: "protected", path: rel, glob } : { kind: "allow" };
}

export function protectedBlockReason(path: string, glob: string, detail?: string): string {
  return (
    `Blocked by Kady's data guard: "${path}" is protected raw data (policy: ${glob})` +
    (detail ? ` — ${detail}` : "") +
    ". Raw uploads are read-only. Copy what you need into a working folder " +
    "(for example derived/) and operate on the copy. The user can change the " +
    "protected paths in the project settings."
  );
}
