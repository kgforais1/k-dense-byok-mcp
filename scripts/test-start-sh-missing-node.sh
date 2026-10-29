#!/bin/sh
# Offline test for start.sh's missing-Node Homebrew path.
#
# Uses a fake `brew` and fake `node` binaries in an isolated PATH — real brew
# is never invoked and nothing is installed. Verifies:
#   A. missing node -> `brew install node@24`, keg bin prepended, launcher
#      execs the keg's node (not PATH lottery);
#   B. pre-existing node -> brew never invoked, launcher uses it directly;
#   C. failed `brew install` -> clear error, node never executed;
#   D. unresolvable `brew --prefix` after install -> clear error, no exec.
#
# Run:  sh scripts/test-start-sh-missing-node.sh   (POSIX sh is enough)
# Exit status is 0 only if every assertion holds.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
# Resolved before any PATH restriction below: the isolated test PATHs contain
# only fakes, so `bash` would not be found by name there.
BASH_BIN="$(command -v bash)"
# Core utilities start.sh itself needs before any node/brew lookup (dirname).
# Symlinked, never shadowed: the fixture PATHs below contain no other entries
# besides these, the fake bin dir, and (where the scenario demands it) a fake
# node — never the real node, brew, or anything else.
COREUTILS="$TMP/coreutils"
mkdir -p "$COREUTILS"
for util in dirname mkdir cp chmod; do
  ln -s "$(command -v "$util")" "$COREUTILS/$util"
done

PASS=0
FAIL=0
ok() {
  PASS=$((PASS + 1))
  echo "ok: $1"
}
bad() {
  FAIL=$((FAIL + 1))
  echo "NOT OK: $1" >&2
  if [ -n "${2:-}" ]; then printf '%s\n' "$2" >&2; fi
}

# A fake `node`: logs how it was invoked and what `node` currently resolves
# to, then exits with $FAKE_NODE_EXIT. Never runs real code.
make_fake_node() {
  cat > "$1" <<'EOF'
#!/bin/sh
echo "node invoked: $0 argv: $*" >> "$NODE_LOG"
echo "node resolves as: $(command -v node)" >> "$NODE_LOG"
exit "$FAKE_NODE_EXIT"
EOF
  chmod +x "$1"
}

# A fake `brew` honouring exactly the two calls start.sh makes. Behaviour is
# driven by env: BREW_LOG (append-only record), KEG_DIR, FAKE_NODE_SRC,
# BREW_INSTALL_RESULT=fail | ok, BREW_PREFIX_RESULT=fail | ok.
make_fake_brew() {
  cat > "$1" <<'EOF'
#!/bin/sh
echo "brew $*" >> "$BREW_LOG"
if [ "${1:-}" = "install" ]; then
  if [ "${BREW_INSTALL_RESULT:-ok}" = "fail" ]; then
    echo "fake brew: install failed" >&2
    exit 1
  fi
  mkdir -p "$KEG_DIR/bin"
  cp "$FAKE_NODE_SRC" "$KEG_DIR/bin/node"
  chmod +x "$KEG_DIR/bin/node"
  exit 0
fi
if [ "${1:-}" = "--prefix" ]; then
  if [ "${BREW_PREFIX_RESULT:-ok}" = "fail" ]; then
    echo "fake brew: no such keg: $2" >&2
    exit 1
  fi
  echo "$KEG_DIR"
  exit 0
fi
echo "fake brew: unexpected call: $*" >&2
exit 99
EOF
  chmod +x "$1"
}

# --- Scenario A: missing node -> brew install node@24, keg bin prepended ---
A="$TMP/a"; mkdir -p "$A/fakebin" "$A/keg"
FAKE_NODE_SRC="$A/node-src.sh" NODE_LOG="$A/node.log" BREW_LOG="$A/brew.log" KEG_DIR="$A/keg"
export FAKE_NODE_SRC NODE_LOG BREW_LOG KEG_DIR
FAKE_NODE_EXIT=42; export FAKE_NODE_EXIT
make_fake_node "$FAKE_NODE_SRC"
make_fake_brew "$A/fakebin/brew"
OUT="$A/out.txt"
if PATH="$A/fakebin:$COREUTILS" "$BASH_BIN" "$REPO_ROOT/start.sh" --check >"$OUT" 2>&1; then
  STATUS=0
else
  STATUS=$?
fi
if [ "$STATUS" -eq 42 ]; then ok "A: launcher execs the keg node (exit 42)"; else bad "A: expected exit 42, got $STATUS" "$(cat "$OUT")"; fi
if grep -q "brew install node@24" "$A/brew.log" 2>/dev/null; then ok "A: brew install node@24 was requested"; else bad "A: no 'brew install node@24' in brew log" "$(cat "$A/brew.log" 2>/dev/null)"; fi
if grep -q "start.mjs" "$A/node.log" 2>/dev/null; then ok "A: keg node received start.mjs"; else bad "A: keg node did not receive start.mjs" "$(cat "$A/node.log" 2>/dev/null)"; fi
if grep -q "node resolves as: $A/keg/bin/node" "$A/node.log" 2>/dev/null; then ok "A: keg bin was first on PATH at exec time"; else bad "A: keg bin was not first on PATH" "$(cat "$A/node.log" 2>/dev/null)"; fi
if grep -Fq "For future terminals, add $A/keg/bin to your PATH." "$OUT"; then ok "A: explains how to retain Node in future terminals"; else bad "A: missing future PATH guidance" "$(cat "$OUT")"; fi

# --- Scenario B: pre-existing node is used untouched, brew never called ---
B="$TMP/b"; mkdir -p "$B/fakebin"
BREW_LOG="$B/brew.log" NODE_LOG="$B/node.log" FAKE_NODE_EXIT=43
export BREW_LOG NODE_LOG FAKE_NODE_EXIT
unset FAKE_NODE_SRC KEG_DIR
make_fake_node "$B/fakebin/node"
make_fake_brew "$B/fakebin/brew"
OUT="$B/out.txt"
if PATH="$B/fakebin:$COREUTILS" "$BASH_BIN" "$REPO_ROOT/start.sh" --check >"$OUT" 2>&1; then
  STATUS=0
else
  STATUS=$?
fi
if [ "$STATUS" -eq 43 ]; then ok "B: pre-existing node used directly (exit 43)"; else bad "B: expected exit 43, got $STATUS" "$(cat "$OUT")"; fi
if [ ! -s "$B/brew.log" ]; then ok "B: brew never invoked"; else bad "B: brew was invoked" "$(cat "$B/brew.log")"; fi

# --- Scenario C: failed brew install fails clearly, node never execs ---
C="$TMP/c"; mkdir -p "$C/fakebin" "$C/keg"
BREW_LOG="$C/brew.log" NODE_LOG="$C/node.log" KEG_DIR="$C/keg" FAKE_NODE_SRC="$C/node-src.sh"
BREW_INSTALL_RESULT=fail FAKE_NODE_EXIT=42
export BREW_LOG NODE_LOG KEG_DIR FAKE_NODE_SRC BREW_INSTALL_RESULT FAKE_NODE_EXIT
make_fake_node "$FAKE_NODE_SRC"
make_fake_brew "$C/fakebin/brew"
OUT="$C/out.txt"
if PATH="$C/fakebin:$COREUTILS" "$BASH_BIN" "$REPO_ROOT/start.sh" --check >"$OUT" 2>&1; then
  STATUS=0
else
  STATUS=$?
fi
if [ "$STATUS" -ne 0 ]; then ok "C: non-zero exit on install failure ($STATUS)"; else bad "C: expected non-zero exit"; fi
if grep -q "node@24" "$OUT" && grep -qi "support" "$OUT"; then ok "C: error names node@24 and supported lines"; else bad "C: error is not actionable" "$(cat "$OUT")"; fi
if [ ! -s "$C/node.log" ]; then ok "C: node never executed"; else bad "C: node was executed" "$(cat "$C/node.log")"; fi

# --- Scenario D: unresolvable --prefix after install fails clearly ---
D="$TMP/d"; mkdir -p "$D/fakebin" "$D/keg"
BREW_LOG="$D/brew.log" NODE_LOG="$D/node.log" KEG_DIR="$D/keg" FAKE_NODE_SRC="$D/node-src.sh"
BREW_INSTALL_RESULT=ok BREW_PREFIX_RESULT=fail FAKE_NODE_EXIT=42
export BREW_LOG NODE_LOG KEG_DIR FAKE_NODE_SRC BREW_INSTALL_RESULT BREW_PREFIX_RESULT FAKE_NODE_EXIT
make_fake_node "$FAKE_NODE_SRC"
make_fake_brew "$D/fakebin/brew"
OUT="$D/out.txt"
if PATH="$D/fakebin:$COREUTILS" "$BASH_BIN" "$REPO_ROOT/start.sh" --check >"$OUT" 2>&1; then
  STATUS=0
else
  STATUS=$?
fi
if [ "$STATUS" -ne 0 ]; then ok "D: non-zero exit on missing keg node ($STATUS)"; else bad "D: expected non-zero exit"; fi
if grep -q "not found where expected" "$OUT"; then ok "D: error names the missing keg binary"; else bad "D: error is not actionable" "$(cat "$OUT")"; fi
if [ ! -s "$D/node.log" ]; then ok "D: node never executed"; else bad "D: node was executed" "$(cat "$D/node.log")"; fi

echo "---"
echo "pass: $PASS fail: $FAIL"
[ "$FAIL" -eq 0 ]
