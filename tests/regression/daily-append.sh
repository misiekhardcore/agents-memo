#!/usr/bin/env bash
# daily-append.sh — AC1 deterministic regression for issue #98.
#
# Drives `obsidian create-or-append` directly, three times back-to-back against
# a scratch file under the active vault, and asserts that all three bullets
# survive — the exact failure mode #98 reported (one bullet silently dropped
# under read-modify-overwrite at the model layer). Because the verbs are pure
# wrapper synthesis with no LLM in the loop, this test is deterministic and
# completes in well under a second when Obsidian is running.
#
# Scope vs cli-smoke: this test is targeted at the bug, not the verb contract.
# Verb-level coverage (file-exists append, file-missing create+append,
# frontmatter-set replace/insert/malformed) lives in tests/cli-smoke.sh.
#
# Scope vs E2E: the former Claude Code e2e local tier (removed — the package is
# now a pi extension) drove /daily through claude -p and validated the model +
# skill + hook + CLI stack end-to-end. This script only verifies the CLI verb
# itself does not lose bullets — that is sufficient for AC1 because the daily
# skill flow has no read-modify-write path the model can corrupt.
#
# Usage:
#   bash tests/regression/daily-append.sh
#
# Exits 0 on pass, 1 on assertion failure, 0 with a skip notice if Obsidian
# is unreachable (matches the cli-smoke skip pattern).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WRAPPER="$PLUGIN_ROOT/scripts/obsidian-cli.sh"

if [ ! -x "$WRAPPER" ]; then
  echo "regression/daily-append: $WRAPPER missing or not executable" >&2
  exit 2
fi

if ! obsidian version >/dev/null 2>&1; then
  echo "regression/daily-append: skipping — obsidian binary unreachable or not running"
  exit 0
fi

VAULT_PATH="$(bash "$PLUGIN_ROOT/scripts/resolve-vault.sh")" || {
  echo "regression/daily-append: skipping — no vault configured"
  exit 0
}

# Scratch path under the active vault — same convention as cli-smoke.
SCRATCH_DIR="_daily-append-regression"
TODAY="$(date +%F)"
SCRATCH_REL="$SCRATCH_DIR/$TODAY.md"
SCRATCH_ABS="$VAULT_PATH/$SCRATCH_REL"

cleanup() { rm -rf "$VAULT_PATH/$SCRATCH_DIR" 2>/dev/null || true; }
trap cleanup EXIT

# Ensure clean slate.
cleanup

PASS=0
FAIL=0
pass() { echo "  [ok] $1"; PASS=$((PASS + 1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

echo ""
echo "=== regression/daily-append — AC1 (#98) ==="

TEMPLATE='---\ntype: daily\ndate: '"$TODAY"'\ncreated: '"$TODAY"'\nupdated: '"$TODAY"'\n---\n\n## Captures\n'

# Three back-to-back create-or-append calls — same-minute timestamps mirror
# the original repro that lost entry 1.
out1=$("$WRAPPER" create-or-append "file=$SCRATCH_REL" "template=$TEMPLATE" "content=- 17:14 entry one"); rc1=$?
out2=$("$WRAPPER" create-or-append "file=$SCRATCH_REL" "template=$TEMPLATE" "content=- 17:14 entry two"); rc2=$?
out3=$("$WRAPPER" create-or-append "file=$SCRATCH_REL" "template=$TEMPLATE" "content=- 17:15 entry three"); rc3=$?

[ "$rc1" -eq 0 ] && pass "call 1 exit 0" || fail "call 1 exit=$rc1, output=$out1"
[ "$rc2" -eq 0 ] && pass "call 2 exit 0" || fail "call 2 exit=$rc2, output=$out2"
[ "$rc3" -eq 0 ] && pass "call 3 exit 0" || fail "call 3 exit=$rc3, output=$out3"

case "$out1" in "Created and appended:"*) pass "call 1 — created+appended branch" ;;
                *)                          fail "call 1 — expected 'Created and appended:'; got: $out1" ;; esac
case "$out2" in "Appended to:"*)            pass "call 2 — file-exists append branch" ;;
                *)                          fail "call 2 — expected 'Appended to:'; got: $out2" ;; esac
case "$out3" in "Appended to:"*)            pass "call 3 — file-exists append branch" ;;
                *)                          fail "call 3 — expected 'Appended to:'; got: $out3" ;; esac

# Read the file and assert all three bullets survived. Read via the wrapper to
# match the real skill's I/O path; `obsidian read` returns the file body
# verbatim per _shared/cli.md §3.
body=$("$WRAPPER" read "path=$SCRATCH_REL" 2>/dev/null) || true

assert_contains() {
  if echo "$body" | grep -qF -- "$1"; then pass "body contains '$1'"
  else fail "body missing '$1'; got:\n$(printf '%s\n' "$body" | sed 's/^/      /')"
  fi
}
assert_contains "- 17:14 entry one"
assert_contains "- 17:14 entry two"
assert_contains "- 17:15 entry three"

# Frontmatter `updated:` bump via property:set — exercises AC3.
fm_out=$("$WRAPPER" property:set name=updated "value=$TODAY" type=date "path=$SCRATCH_REL"); fm_rc=$?
[ "$fm_rc" -eq 0 ] && pass "property:set exit 0" || fail "property:set exit=$fm_rc, output=$fm_out"

# Bullets must still be intact after the property:set roundtrip.
body_after=$("$WRAPPER" read "path=$SCRATCH_REL" 2>/dev/null) || true
body=$body_after
assert_contains "- 17:14 entry one"
assert_contains "- 17:14 entry two"
assert_contains "- 17:15 entry three"
assert_contains "updated: $TODAY"

echo ""
echo "=== summary ==="
echo "  pass=$PASS  fail=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
