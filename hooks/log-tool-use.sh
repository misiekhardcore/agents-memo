#!/usr/bin/env bash
# PostToolUse hook (Edit|Write): append the touched file path to a per-vault
# scratch log. The SessionEnd reflection reads this log to summarize patterns
# and learnings. Silent on any failure — this hook must never disrupt a turn.

set -e

# Locate the plugin root. Under pi the extension rewrites ${MEMO_PLUGIN_PWD} into
# the command; under Claude Code it is unset, so fall back to script location.
MEMO_PLUGIN_PWD="${MEMO_PLUGIN_PWD:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export MEMO_PLUGIN_PWD

VAULT=$("${MEMO_PLUGIN_PWD}/scripts/resolve-vault.sh") 2>/dev/null || exit 0
[ -d "$VAULT" ] || exit 0

# Read the tool-use payload from stdin. jq is preferred; fall back to a crude
# regex so the hook still works on systems without jq installed.
INPUT=$(cat)
FILE_PATH=""
if command -v jq >/dev/null 2>&1; then
  FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)
fi
if [ -z "$FILE_PATH" ]; then
  FILE_PATH=$(printf '%s' "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -n1 \
    | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
fi

[ -z "$FILE_PATH" ] && exit 0

SCRATCH="$VAULT/.session-scratch.log"
printf '%s\t%s\n' "$(date -Iseconds 2>/dev/null || date)" "$FILE_PATH" >> "$SCRATCH" 2>/dev/null || true
exit 0
