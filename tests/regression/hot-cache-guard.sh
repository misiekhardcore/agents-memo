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

# Scratch vault — the hook resolves the vault via resolve-vault.sh. With pi
# settings present (tier 0) a user-configured agentsMemo.vaultPath would win,
# so sandbox HOME to keep resolution on the scratch vault's wiki/ fallback.
SCRATCH_ROOT="$(mktemp -d)"
trap 'rm -rf "$SCRATCH_ROOT"' EXIT
mkdir -p "$SCRATCH_ROOT/wiki" "$SCRATCH_ROOT/home"
cd "$SCRATCH_ROOT"
export HOME="$SCRATCH_ROOT/home"
export MEMO_PLUGIN_PWD="$PLUGIN_ROOT"

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
    | bash "$GUARD"
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
if echo "$out2" | grep -q "no usable"; then
  pass "case 2 — warning mentions no usable prior version"
else
  fail "case 2 — expected 'no usable' warning; got: $out2"
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

# --- Case 5: empty hot.md staged in the index → still restored from HEAD ---
# git show HEAD:wiki/hot.md reads the committed blob, not the index, so a
# staged-but-empty file must not freeze the corrupt state (parity with the
# extension's `git checkout HEAD -- wiki/hot.md`).
rm -rf "$SCRATCH_ROOT/.git" "$SCRATCH_ROOT/wiki"
mkdir -p "$SCRATCH_ROOT/wiki"
cd "$SCRATCH_ROOT"
git init -q .
printf -- '---\ntype: meta\ntitle: Hot Cache\nupdated: 2026-08-06\n---\n\n# good committed content\n' > wiki/hot.md
git add wiki/hot.md && git -c user.email=t@t -c user.name=t commit -qm init
: > wiki/hot.md
git add wiki/hot.md  # stage the empty version; index now differs from HEAD
out5=$(run_guard 'obsidian create path=wiki/hot.md overwrite=true content=""')
if echo "$out5" | grep -q "restored"; then
  pass "case 5 — warning mentions git restore for staged-empty hot.md"
else
  fail "case 5 — expected 'restored' warning; got: $out5"
fi
if grep -q "good committed content" wiki/hot.md; then
  pass "case 5 — working tree recovered from HEAD despite staged empty index"
else
  fail "case 5 — hot.md not recovered; contents: $(cat wiki/hot.md)"
fi

# --- Case 6: HEAD itself is empty → not restorable, remove + warn ---
# git checkout HEAD -- succeeds but restores the empty blob; the guard must
# treat that as not-restorable and drop the file instead of reporting a fake
# restore (parity with the extension's post-restore size check).
rm -rf "$SCRATCH_ROOT/.git" "$SCRATCH_ROOT/wiki"
mkdir -p "$SCRATCH_ROOT/wiki"
cd "$SCRATCH_ROOT"
git init -q .
: > wiki/hot.md
git add wiki/hot.md && git -c user.email=t@t -c user.name=t commit -qm "empty hot"
out6=$(run_guard 'obsidian create path=wiki/hot.md overwrite=true content=""')
if echo "$out6" | grep -q "no usable"; then
  pass "case 6 — empty HEAD treated as not-restorable"
else
  fail "case 6 — expected 'no usable' warning; got: $out6"
fi
if [ ! -e wiki/hot.md ]; then
  pass "case 6 — empty hot.md removed when HEAD itself is empty"
else
  fail "case 6 — empty hot.md still present"
fi

echo ""
echo "=== summary ==="
echo "  pass=$PASS  fail=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
