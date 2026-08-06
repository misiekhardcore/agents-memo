#!/usr/bin/env bash
# Regression: in-worktree guard on scripts/prune-lint-reports.sh.
#
# Covers the hermetic-safe shapes of the guard:
#   - bare invocation (MEMO_PLUGIN_PWD unset) + external vault → refusal, exit 2
#   - argument validation (--force parsing / bad keep) → exit 2 before any
#     vault resolution
# The --force bypass against an external vault is intentionally NOT tested
# here: it reaches the obsidian CLI, which resolves the Obsidian *active*
# vault for unknown vault names, so it cannot be hermetic. It was manually
# live-verified during development and is covered by code review only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PRUNE="$ROOT/scripts/prune-lint-reports.sh"

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
export HOME="$SCRATCH/home"
mkdir -p "$HOME/.pi/agent" "$SCRATCH/vault"
# External vault configured via pi settings (tier 0a), like the incident.
printf '{"agentsMemo": { "vaultPath": "%s/vault" }}\n' "$SCRATCH" > "$HOME/.pi/agent/settings.json"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "[ok] $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "[FAIL] $1"; }

cd "$SCRATCH" # no wiki/ here — isolate CWD discovery

# 1. Bare invocation + external vault → refusal (exit 2), no CLI interaction.
OUT="$(env -u MEMO_PLUGIN_PWD bash "$PRUNE" 2>&1)" && RC=0 || RC=$?
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -q "refusing to prune"; then
  ok "bare + external vault → refusal (exit 2)"
else
  bad "bare + external vault → expected exit 2 + refusal, got rc=$RC: $OUT"
fi
if printf '%s' "$OUT" | grep -q -- "--force"; then
  ok "refusal message names --force escape hatch"
else
  bad "refusal message missing --force hint: $OUT"
fi

# 2. Argument validation happens before vault resolution (safe with --force).
OUT="$(env -u MEMO_PLUGIN_PWD bash "$PRUNE" --force abc 2>&1)" && RC=0 || RC=$?
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -q "positive integer"; then
  ok "--force with bad keep → argument error (exit 2)"
else
  bad "--force abc → expected argument error, got rc=$RC: $OUT"
fi

# 3. Unset vault (no pi settings, no wiki/) → vault resolution error, not a guard refusal.
rm -f "$HOME/.pi/agent/settings.json"
OUT="$(env -u MEMO_PLUGIN_PWD bash "$PRUNE" 2>&1)" && RC=0 || RC=$?
if [ "$RC" -eq 1 ] && printf '%s' "$OUT" | grep -q "could not resolve vault"; then
  ok "no vault → resolution error (exit 1)"
else
  bad "no vault → expected resolution error, got rc=$RC: $OUT"
fi

echo
echo "=== summary ==="
echo "  pass=$PASS  fail=$FAIL"
[ "$FAIL" -eq 0 ]
