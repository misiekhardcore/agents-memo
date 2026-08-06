#!/usr/bin/env bash
# obsidian-cli-rewrite.sh — PreToolUse hook (matcher: Bash).
#
# Transparently rewrites raw `obsidian ...` invocations into calls through
# scripts/obsidian-cli.sh so that vault resolution, the version pre-flight,
# and exit-code normalization always apply. Inspired by RTK's hook pattern
# (https://github.com/rtk-ai/rtk).
#
# Rewrite is deliberately conservative:
#   - Only rewrites commands whose FIRST token is exactly `obsidian` (so
#     `which obsidian`, `pgrep obsidian`, `cat $obsidian_path` are untouched).
#   - Skips if the command already mentions `obsidian-cli` anywhere.
#   - On any error (jq missing, malformed JSON), exits 0 → unchanged.
#
# Output protocol: emits `hookSpecificOutput` with `permissionDecision: allow`
# and `updatedInput.command` set to the rewritten form. The model never sees
# the rewrite — the new command runs as if it had been authored that way.

set -u

# Need jq to parse and emit hook JSON. Without it, pass through unchanged.
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$CMD" ] && exit 0
ORIGINAL_CMD="$CMD"

# Resolve the plugin root from this script's own location and embed the
# absolute path literally in the rewritten command.
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Substitute ${MEMO_PLUGIN_PWD} (braced and bare forms) with the resolved
# plugin root — parity with the pi extension's tool_call rewrite. Skill and
# agent docs reference the pi-era variable, but the Claude Code Bash tool runs
# without it set; substituting here keeps skill-authored commands working
# under both runtimes. Must run before the obsidian-cli early exit so
# already-routed commands that use the variable still get substituted.
#
# The root is escaped for sed replacement use (\&, \\, \~ → literal), so
# install paths containing those characters embed literally. The loop runs to
# convergence because the bare-form boundary class restores the char it
# consumed (e.g. adjacent `$MEMO_PLUGIN_PWD$MEMO_PLUGIN_PWD` needs two
# passes; four bounds any sane command).
PLUGIN_ROOT_SED=$(printf '%s' "$PLUGIN_ROOT" | sed 's/[&\\~]/\\&/g')
for _ in 1 2 3 4; do
  SUBSTITUTED=$(printf '%s' "$CMD" \
    | sed -e "s~\${MEMO_PLUGIN_PWD}~${PLUGIN_ROOT_SED}~g" \
          -e "s~\$MEMO_PLUGIN_PWD\([^A-Za-z0-9_]\)~${PLUGIN_ROOT_SED}\1~g" \
          -e "s~\$MEMO_PLUGIN_PWD$~${PLUGIN_ROOT_SED}~")
  [ "$SUBSTITUTED" = "$CMD" ] && break
  CMD="$SUBSTITUTED"
done

# Already routed through the wrapper — emit only if the MEMO substitution
# changed the command; otherwise pass through unchanged.
case "$CMD" in
  *obsidian-cli*)
    if [ "$CMD" != "$ORIGINAL_CMD" ]; then
      ORIGINAL_INPUT=$(echo "$INPUT" | jq -c '.tool_input')
      UPDATED_INPUT=$(echo "$ORIGINAL_INPUT" | jq --arg cmd "$CMD" '.command = $cmd')
      jq -n \
        --argjson updated "$UPDATED_INPUT" \
        '{
          "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": "MEMO_PLUGIN_PWD substitution (agents-memo)",
            "updatedInput": $updated
          }
        }'
    fi
    exit 0 ;;
esac

# Antipattern guard (issue #98): block `obsidian create … overwrite=true` calls
# whose `path=` targets `daily/*.md`. The /daily skill must use the wrapper-only
# `create-or-append` verb for appends and the native `property:set` verb for
# property updates. Read-modify-overwrite of a daily file at the model layer is
# the root cause of bullet loss in #98 — this guard catches the regression.
#
# Path-scoped to `daily/*.md` so legitimate full-rewrite callers
# (daily-close synthesis, obsidian-bases templates, save promotions) are
# unaffected. Detection is substring-based on the verbatim command, so it
# survives multi-line / continuation / heredoc shapes.
DAILY_VIOLATION=0
case "$CMD" in
  *"obsidian"*"create"*)
    if printf '%s' "$CMD" | grep -qE 'path=("?)daily/[^[:space:]"]*\.md' \
       && printf '%s' "$CMD" | grep -qE 'overwrite=true|overwrite=1|overwrite([[:space:]]|$)'; then
      DAILY_VIOLATION=1
    fi
    ;;
esac

if [ "$DAILY_VIOLATION" = 1 ]; then
  jq -n '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "obsidian create overwrite=true on daily/*.md is forbidden (issue #98). Use obsidian create-or-append for appends or obsidian property:set for property updates. See _shared/cli.md §3.1, §3.2."
    }
  }'
  exit 0
fi

# Rewrite ONLY the leading `obsidian` token on the first line. Preserves
# multi-line commands (backslash continuations, here-docs, embedded newlines)
# verbatim after the first token. Mid-string occurrences of `obsidian` (e.g.
# inside content=, comments) are not touched.
REWRITTEN=$(printf '%s' "$CMD" | sed -E "1 s~^([[:space:]]*)obsidian([[:space:]]|\$)~\1\"${PLUGIN_ROOT_SED}/scripts/obsidian-cli.sh\"\2~")

# No-op only if neither the leading-token rewrite nor the MEMO substitution
# changed the command (e.g. `which obsidian`, `cat $obsidian_path`, or a
# plain command with no MEMO_PLUGIN_PWD reference).
if [ "$REWRITTEN" = "$CMD" ] && [ "$CMD" = "$ORIGINAL_CMD" ]; then exit 0; fi

# Emit the rewritten tool_input. Preserve all other fields (e.g. `description`).
ORIGINAL_INPUT=$(echo "$INPUT" | jq -c '.tool_input')
UPDATED_INPUT=$(echo "$ORIGINAL_INPUT" | jq --arg cmd "$REWRITTEN" '.command = $cmd')
jq -n \
  --argjson updated "$UPDATED_INPUT" \
  '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "allow",
      "permissionDecisionReason": "obsidian-cli auto-rewrite (agents-memo)",
      "updatedInput": $updated
    }
  }'
