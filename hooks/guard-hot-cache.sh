#!/usr/bin/env bash
# guard-hot-cache.sh — PostToolUse hook (matcher: Bash)
#
# Guards wiki/hot.md against silent 0-byte corruption (observed 2026-06-14:
# a save-cycle overwrite produced an empty file, the obsidian-cli wrapper's
# exit-code normalization masked the failure, and the auto-commit hook froze
# the empty state into git for seven weeks).
#
# Runs after any Bash command whose text mentions wiki/hot.md. If the file
# exists but is empty:
#   1. Restores the last good version from git (HEAD:wiki/hot.md) — or
#      removes the empty file if git has no prior version.
#   2. Injects a warning into the conversation via additionalContext so the
#      agent knows the write failed and must retry with non-empty content.
#
# Fail-open: missing jq, unresolvable vault, or unparseable input all exit 0.
# Must never disrupt the turn.

set -u

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -z "$CMD" ] && exit 0

# Only commands that reference wiki/hot.md can have corrupted it.
case "$CMD" in
  *wiki/hot.md*) ;;
  *) exit 0 ;;
esac

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT=$("${PLUGIN_ROOT}/scripts/resolve-vault.sh" 2>/dev/null) || exit 0
[ -n "$VAULT" ] && [ -d "$VAULT" ] || exit 0

HOT="$VAULT/wiki/hot.md"

# Non-existent is fine (bootstrap state); only empty-but-present is corruption.
[ -f "$HOT" ] || exit 0
[ -s "$HOT" ] && exit 0

# Restore from git if a usable (non-empty) HEAD version exists; otherwise
# drop the empty file. `git checkout HEAD --` resets index AND working tree
# (the extension uses the same command), so a staged-empty blob is not frozen.
# An empty blob committed at HEAD is treated as not-restorable — the restore
# would only recreate the corruption.
RESTORED=0
# rev-parse --git-dir handles both plain repos (.git dir) and worktrees
# (.git file) — a vault in a git worktree must restore, not remove.
if git -C "$VAULT" rev-parse --git-dir >/dev/null 2>&1; then
  if git -C "$VAULT" checkout HEAD -- "wiki/hot.md" 2>/dev/null && [ -s "$HOT" ]; then
    RESTORED=1
  fi
fi
if [ "$RESTORED" -eq 0 ]; then
  rm -f "$HOT"
fi

if [ "$RESTORED" -eq 1 ]; then
  MSG="[agents-memo] WARNING: your write left wiki/hot.md empty (0 bytes) — likely a failed or truncated content= parameter. The previous version from git has been restored. Please retry the hot.md update with non-empty content per the hot-cache protocol (~500 words, sections: Last Updated, Key Recent Facts, Recent Changes, Active Threads; overwrite completely)."
else
  MSG="[agents-memo] WARNING: your write left wiki/hot.md empty (0 bytes) and no usable (non-empty) prior version exists in git, so the empty file was removed. Please retry the hot.md update with non-empty content per the hot-cache protocol."
fi

jq -n --arg msg "$MSG" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $msg
  }
}'
