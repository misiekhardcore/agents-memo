#!/usr/bin/env bash
# PostToolUse hook (Bash): append a log line to $VAULT/.obsidian-cli.log for
# every Bash command that routes through obsidian-cli.sh.
#
# Silent on any failure — this hook must never disrupt a turn.

# Locate the plugin root. Under pi the extension rewrites ${MEMO_PLUGIN_PWD} into
# the command; under Claude Code it is unset, so fall back to script location.
MEMO_PLUGIN_PWD="${MEMO_PLUGIN_PWD:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export MEMO_PLUGIN_PWD

VAULT=$("${MEMO_PLUGIN_PWD}/scripts/resolve-vault.sh") 2>/dev/null || exit 0
[ -d "$VAULT" ] || exit 0

# jq is a hard prerequisite for this hook; exit silently if absent.
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -z "$CMD" ] && exit 0

# Join backslash continuations, collapse whitespace, then strip content=/template=
# args whose values can contain "obsidian-cli.sh" text (false-positive guard).
# Invariant: content= and template= must be the last args in any obsidian command;
# everything after them is silently dropped, including KEY_ARG extraction.
CMD_EXEC=$(printf '%s' "$CMD" \
  | tr '\n' ' ' \
  | sed -e 's/ *\\ */ /g' -e 's/  */ /g' -e 's/ content=.*//' -e 's/ template=.*//')

# Strip leading KEY=val assignments; require first token to be "obsidian" or "…/obsidian-cli.sh".
CMD_NOENV=$(printf '%s' "$CMD_EXEC" | sed -E 's/^([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+ )*//')
case "$CMD_NOENV" in
  *obsidian-cli.sh*|obsidian\ *|obsidian) ;;
  *) exit 0 ;;
esac

# The sed requires a space after obsidian-cli.sh, so path args (e.g. path=wiki/obsidian-cli.sh-foo.md)
# don't match the first sub and fall through to the second.
VERB=$(printf '%s' "$CMD_EXEC" \
  | sed -E 's/.*obsidian-cli\.sh[^[:space:]]* //; s/^([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+ )*obsidian //' \
  | awk '{print $1}')

KEY_ARG=$(printf '%s' "$CMD_EXEC" \
  | grep -oEm1 '(path|file|query)=[^[:space:]"]+' \
  | sed 's/^[^=]*=//' || true)

TS=$(date -Iseconds 2>/dev/null || date)
printf '%s\t%s\t%s\n' "$TS" "${VERB:-?}" "${KEY_ARG:-}" \
  >> "$VAULT/.obsidian-cli.log" 2>/dev/null || true

case "${VERB:-}" in
  create|append|prepend|create-or-append|property:set|property:remove|eval)
    # rev-parse --git-dir handles worktree vaults (.git file) too, matching
    # guard-hot-cache.sh — a worktree vault must auto-commit, not skip.
    git -C "$VAULT" rev-parse --git-dir >/dev/null 2>&1 \
      && git -C "$VAULT" add wiki/ .raw/ 2>/dev/null \
      && (git -C "$VAULT" diff --cached --quiet \
           || git -C "$VAULT" commit -m "wiki: auto-commit $(date '+%Y-%m-%d %H:%M')" 2>/dev/null) \
      || true
    ;;
esac

exit 0
