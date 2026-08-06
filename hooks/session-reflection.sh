#!/usr/bin/env bash
# SessionEnd hook: generate a brief end-of-session reflection using Haiku and
# append it to the vault's daily note at daily/YYYY-MM-DD.md.
#
# Non-blocking: any failure (missing claude CLI, API error, timeout) exits
# cleanly so the session terminates normally. Auto-memory at
# ~/.claude/projects/*/memory/ already captures raw facts, so this reflection
# intentionally focuses on PATTERNS and LEARNINGS, not a transcript.

set -e

# Locate the plugin root. Under pi the extension rewrites ${MEMO_PLUGIN_PWD} into
# the command; under Claude Code it is unset, so fall back to script location.
MEMO_PLUGIN_PWD="${MEMO_PLUGIN_PWD:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export MEMO_PLUGIN_PWD

VAULT=$("${MEMO_PLUGIN_PWD}/scripts/resolve-vault.sh") 2>/dev/null || exit 0
[ -d "$VAULT" ] || exit 0

SCRATCH="$VAULT/.session-scratch.log"
[ -f "$SCRATCH" ] || exit 0

# Deduplicate touched files (path column), cap list length to keep prompt cheap.
TOUCHED=$(awk -F'\t' 'NF>=2{print $2}' "$SCRATCH" 2>/dev/null | sort -u | head -40)
if [ -z "$TOUCHED" ]; then
  rm -f "$SCRATCH"
  exit 0
fi

# Skip silently if the claude CLI is unavailable — reflection is best-effort.
if ! command -v claude >/dev/null 2>&1; then
  rm -f "$SCRATCH"
  exit 0
fi

DATE=$(date +%Y-%m-%d)
TIME=$(date +%H:%M)
DAILY_DIR="$VAULT/daily"
DAILY_FILE="$DAILY_DIR/$DATE.md"
mkdir -p "$DAILY_DIR" 2>/dev/null || true

PROMPT=$(cat <<EOF
You are writing a brief end-of-session reflection for an Obsidian vault.

Focus on PATTERNS, DECISIONS, and LEARNINGS — not raw facts. Auto-memory
already captures the factual transcript; this reflection complements it with
compressed insight.

Files touched this session:
$TOUCHED

Write 3-5 short markdown bullets under a "### Session $TIME" heading. Each
bullet = one pattern, insight, decision, or gotcha worth remembering. No
preamble, no closing remarks — markdown only.
EOF
)

# Cap at 60s so a stuck CLI never blocks logout.
REFLECTION=$(timeout 60 claude -p --model claude-haiku-4-5 "$PROMPT" 2>/dev/null) || REFLECTION=""

if [ -n "$REFLECTION" ]; then
  {
    if [ ! -f "$DAILY_FILE" ]; then
      printf '# %s\n\n' "$DATE"
    fi
    printf '\n%s\n' "$REFLECTION"
  } >> "$DAILY_FILE" 2>/dev/null || true
fi

rm -f "$SCRATCH" || true
exit 0
