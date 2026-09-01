#!/usr/bin/env bash
# End-to-end test for the /memo:init command against a REAL pi instance.
#
# Bootstraps a scratch vault, runs /memo:init headless in an isolated HOME
# (via bin/e2e-command.sh), then asserts the resulting vault artifacts.
# Also checks the unconfigured-vault path exits cleanly.
#
# Usage: bin/e2e-init.sh [--keep]

set -euo pipefail

KEEP=0
[ "${E2E_KEEP:-0}" = "1" ] && KEEP=1
[ $# -gt 0 ] && [ "$1" = "--keep" ] && KEEP=1

# Locate the plugin root (same convention as other bin/ scripts).
if [ -z "${MEMO_PLUGIN_PWD:-}" ]; then
  SCRIPT_PATH=$(readlink -f "$0" 2>/dev/null || python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$0")
  MEMO_PLUGIN_PWD=$(dirname "$(dirname "$SCRIPT_PATH")")
  export MEMO_PLUGIN_PWD
fi

WORK=$(mktemp -d)
trap '[ "$KEEP" = "1" ] || rm -rf "$WORK"' EXIT
VAULT="$WORK/vault"
mkdir -p "$VAULT"

FAIL=0
check() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  ok  $desc"
  else
    echo "  FAIL $desc"
    FAIL=1
  fi
}

echo "=== [1/2] /memo:init with configured vault (isolated HOME, real pi) ==="
if ! bash "$MEMO_PLUGIN_PWD/bin/e2e-command.sh" "memo:init" --vault "$VAULT" >/dev/null 2>&1; then
  echo "FAIL: /memo:init exited non-zero"
  exit 1
fi

echo "=== [2/2] /memo:init with NO vault configured (graceful, exit 0) ==="
if ! bash "$MEMO_PLUGIN_PWD/bin/e2e-command.sh" "memo:init" --no-vault >/dev/null 2>&1; then
  echo "FAIL: no-vault path exited non-zero"
  exit 1
fi

echo "=== [3/3] re-run on the SAME vault (idempotent, still exit 0) ==="
if ! bash "$MEMO_PLUGIN_PWD/bin/e2e-command.sh" "memo:init" --vault "$VAULT" >/dev/null 2>&1; then
  echo "FAIL: re-run exited non-zero"
  exit 1
fi

echo "=== [4/4] EXISTING vault: .obsidian config must NOT be clobbered ==="
EXISTING="$WORK/existing"
mkdir -p "$EXISTING/.obsidian" "$EXISTING/wiki/concepts"
echo '{"custom":"keep-me"}' > "$EXISTING/.obsidian/app.json"
echo '# Pre-existing page' > "$EXISTING/wiki/concepts/pre-existing.md"
if ! bash "$MEMO_PLUGIN_PWD/bin/e2e-command.sh" "memo:init" --vault "$EXISTING" >/dev/null 2>&1; then
  echo "FAIL: existing-vault init exited non-zero"
  exit 1
fi
check "existing .obsidian/app.json preserved" grep -q keep-me "$EXISTING/.obsidian/app.json"
check "pre-existing wiki page preserved" test -f "$EXISTING/wiki/concepts/pre-existing.md"
check "existing vault gained AGENTS.md" test -f "$EXISTING/AGENTS.md"

echo "=== artifact assertions (vault: $VAULT) ==="
check "wiki dirs (concepts/entities/sources/questions/meta)" \
  test -d "$VAULT/wiki/concepts" -a -d "$VAULT/wiki/entities" -a -d "$VAULT/wiki/sources" -a -d "$VAULT/wiki/questions" -a -d "$VAULT/wiki/meta"
check "structure dirs (.raw/_templates/.obsidian/notes/daily)" \
  test -d "$VAULT/.raw" -a -d "$VAULT/_templates" -a -d "$VAULT/.obsidian" -a -d "$VAULT/notes" -a -d "$VAULT/daily"
check "seed files (hot/index/log/overview/FIRST_RUN)" \
  test -f "$VAULT/wiki/hot.md" -a -f "$VAULT/wiki/index.md" -a -f "$VAULT/wiki/log.md" -a -f "$VAULT/wiki/overview.md" -a -f "$VAULT/FIRST_RUN.md"
check "example pages" \
  test -f "$VAULT/wiki/concepts/example-concept.md" -a -f "$VAULT/wiki/sources/example-source.md"
check "git initialized" test -d "$VAULT/.git"
check "vault AGENTS.md written" test -f "$VAULT/AGENTS.md"
check "AGENTS.md placeholders substituted" bash -c "! grep -q '{{' '$VAULT/AGENTS.md'"
check "AGENTS.md references plugin root" grep -q "$MEMO_PLUGIN_PWD" "$VAULT/AGENTS.md"

if [ "$KEEP" = "1" ]; then
  echo "  (kept: $WORK — vault/ + scratch home/project were cleaned up by the runner)"
fi

if [ "$FAIL" = "1" ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
