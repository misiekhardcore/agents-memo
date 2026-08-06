#!/usr/bin/env bash
# hot-cache-guard.sh — regression for the 0-byte wiki/hot.md corruption.
#
# Drives hooks/guard-hot-cache.sh directly against a scratch vault and asserts
# both branches:
#   1. empty hot.md + git HEAD version  → HEAD version restored, warning emitted
#   2. empty hot.md + no git HEAD version → empty file removed, warning emitted
#   3. non-empty hot.md → untouched, no warning (exit 0, no hook output)
#
# The hook is deterministic (pure shell, no LLM in the loop). It does not
# require Obsidian to be running — the guard only touches git and the file.
#
# Usage:
#   bash tests/regression/hot-cache-guard.sh
#
# Exits 0 on pass, 1 on assertion failure.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GUARD="$PLUGIN_ROOT/hooks/guard-hot-cache.sh"

if [ ! -x "$GUARD" ]; then
  echo "regression/hot-cache-guard: $GUARD missing or not executable" >&2
  exit 2
fi

command -v jq >/dev/null 2>&1 || {
  echo "regression/hot-cache-guard: skipping — jq not installed"
  exit 0
}

# Scratch vault — the hook resolves the vault from the plugin config/CWD, so
# point MEMO_PLUGIN_PWD at the plugin and run from a temp git repo whose
# wiki/ layout mimics the real vault.
SCRATCH_ROOT="$(mktemp -d)"
trap 'rm -rf "$SCRATCH_ROOT"' EXIT
mkdir -p "$SCRATCH_ROOT/wiki"
cd "$SCRATCH_ROOT"

PASS=0
FAIL=0
pass() { echo "  [ok] $1"; PASS=$((PASS + 1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

echo ""
echo "=== regression/hot-cache-guard — 0-byte hot.md guard ==="

# The hook resolves the vault via resolve-vault.sh, which falls back to
# "$(pwd) contains a wiki/ directory" — the scratch vault satisfies that.
# No stub needed; the test runs from SCRATCH_ROOT.

# Run the guard with a faked PostToolUse input JSON. The command text is
# base64-encoded to avoid JSON escaping issues with embedded quotes.
run_guard() {
  local cmd="$1"
  local b64
  b64=$(printf '%s' "$cmd" | base64 -w0)
  local decoded
  decoded=$(printf '%s' "$b64" | base64 -d)
  printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$(printf '%s' "$decoded" | sed 's/"/\\"/g')" \
    | MEMO_PLUGIN_PWD="$PLUGIN_ROOT" bash "$GUARD"
}

# --- Case 1: empty hot.md, git HEAD has a version → restore + warn ---
rm -rf "$SCRATCH_ROOT/.git" "$SCRATCH_ROOT/wiki"
mkdir -p "$SCRATCH_ROOT/wiki"
cd "$SCRATCH_ROOT"
git init -q .
printf -- '---\ntype: meta\ntitle: Hot Cache\nupdated: 2026-08-06\n---\n\n# prior good content\n' > wiki/hot.md
git add wiki/hot.md && git -c user.email=t@t -c user.name=t commit -qm init
: > wiki/hot.md  # simulate corrupting write

out1=$(run_guard 'obsidian create path=wiki/hot.md overwrite=true content=""')
if echo "$out1" | grep -q "restored"; then
  pass "case 1 — warning mentions git restore"
else
  fail "case 1 — expected 'restored' warning; got: $out1"
fi
if grep -q "prior good content" wiki/hot.md; then
  pass "case 1 — hot.md restored from HEAD"
else
  fail "case 1 — hot.md not restored; contents: $(cat wiki/hot.md)"
fi

# --- Case 2: empty hot.md, no git version → remove + warn ---
rm -rf "$SCRATCH_ROOT/.git" "$SCRATCH_ROOT/wiki"
mkdir -p "$SCRATCH_ROOT/wiki"
cd "$SCRATCH_ROOT"
git init -q .
: > wiki/hot.md

out2=$(run_guard 'obsidian create path=wiki/hot.md overwrite=true content=""')
if echo "$out2" | grep -q "no prior version"; then
  pass "case 2 — warning mentions no prior version"
else
  fail "case 2 — expected 'no prior version' warning; got: $out2"
fi
if [ ! -e wiki/hot.md ]; then
  pass "case 2 — empty hot.md removed"
else
  fail "case 2 — empty hot.md still present"
fi

# --- Case 3: non-empty hot.md → untouched, silent ---
printf -- '---\ntype: meta\ntitle: Hot Cache\nupdated: 2026-08-06\n---\n\n# fine content\n' > wiki/hot.md
out3=$(run_guard 'obsidian create path=wiki/hot.md overwrite=true content="fine"')
if [ -z "$out3" ]; then
  pass "case 3 — no hook output for healthy hot.md"
else
  fail "case 3 — expected silence; got: $out3"
fi
if grep -q "fine content" wiki/hot.md; then
  pass "case 3 — hot.md untouched"
else
  fail "case 3 — hot.md modified"
fi

# --- Case 4: unrelated command → never touched ---
rm -rf "$SCRATCH_ROOT/.git" "$SCRATCH_ROOT/wiki"
mkdir -p "$SCRATCH_ROOT/wiki"
cd "$SCRATCH_ROOT"
git init -q .
: > wiki/hot.md
out4=$(run_guard 'ls -la /tmp')
if [ -z "$out4" ] && [ -f wiki/hot.md ]; then
  pass "case 4 — unrelated command: no output, file left alone"
else
  fail "case 4 — unrelated command should be ignored (out='$out4', file=$(ls -la wiki/hot.md 2>&1))"
fi

echo ""
echo "=== summary ==="
echo "  pass=$PASS  fail=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
