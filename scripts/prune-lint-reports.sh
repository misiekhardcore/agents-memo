#!/usr/bin/env bash
# prune-lint-reports.sh — keep the most recent N lint artifacts in wiki/meta/.
#
# Each lint run writes two files:
#   wiki/meta/lint-report-YYYY-MM-DD.md   — human-readable report
#   wiki/meta/lint-data-YYYY-MM-DD.json   — canonical machine-readable data
#
# Old artifacts accumulate, clutter wiki/meta/, and inflate git diffs even
# though they're advisory: the dashboard already carries the latest summary and
# each new report subsumes the previous findings. This script prunes everything
# beyond the top KEEP artifacts by ISO date (same KEEP applied to both types).
#
# In-worktree guard: when MEMO_PLUGIN_PWD was not set by the caller (bare
# invocation, plugin root derived from script location) the script refuses to
# prune a vault outside this plugin worktree — an accidental dev/test run must
# not delete artifacts from a production vault. Pass --force to override.
#
# Usage:
#   prune-lint-reports.sh            # default keep=3
#   prune-lint-reports.sh 5          # keep most-recent 5
#   prune-lint-reports.sh --force 5  # explicit: prune an external vault
#
# Env:
#   MEMO_PLUGIN_PWD — optional; resolves the obsidian CLI wrapper. Defaults to
#   the plugin root derived from the script location when unset.
#
# Exit codes:
#   0 — pruned (or nothing to prune)
#   1 — obsidian CLI error / vault resolution error
#   2 — argument error, or in-worktree guard refusal

set -euo pipefail

FORCE=0
KEEP="${1:-3}"
if [ "${1:-}" = "--force" ]; then
  FORCE=1
  KEEP="${2:-3}"
fi

if ! [[ "$KEEP" =~ ^[0-9]+$ ]] || [ "$KEEP" -lt 1 ]; then
  echo "prune-lint-reports: <keep> must be a positive integer (got '$KEEP')" >&2
  exit 2
fi

MEMO_PLUGIN_PWD_EXPLICIT="${MEMO_PLUGIN_PWD:-}"
if [ -z "${MEMO_PLUGIN_PWD:-}" ]; then
  # Locate the plugin root. Under pi the extension rewrites ${MEMO_PLUGIN_PWD} into
  # the command; under Claude Code it is unset, so fall back to script location.
  MEMO_PLUGIN_PWD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  export MEMO_PLUGIN_PWD
fi

VAULT="$("${MEMO_PLUGIN_PWD}/scripts/resolve-vault.sh")" || {
  echo "prune-lint-reports: could not resolve vault" >&2; exit 1
}

# In-worktree guard (see header). A bare invocation resolving an external
# vault pruned 2 real files in ~/Projects/claude-memory during a fallback
# verification — refuse that shape unless the caller explicitly forces it.
if [ -z "$MEMO_PLUGIN_PWD_EXPLICIT" ] && [ "$FORCE" -ne 1 ]; then
  case "$VAULT" in
    "$MEMO_PLUGIN_PWD" | "$MEMO_PLUGIN_PWD/"*) ;;
    *)
      echo "prune-lint-reports: refusing to prune '$VAULT' — MEMO_PLUGIN_PWD was unset and the vault is outside the plugin worktree. Pass --force to prune an external vault." >&2
      exit 2 ;;
  esac
fi

CLI="${MEMO_PLUGIN_PWD}/scripts/obsidian-cli.sh"
SKIP=$((KEEP + 1))

prune_pattern() {
  local pattern="$1"
  # ISO-8601 dates sort lexically; sort -r puts newest first; tail -n +SKIP
  # emits everything past the top KEEP.
  "$CLI" files dir=wiki/meta \
    | { grep -E "$pattern" || true; } \
    | sort -r \
    | tail -n "+$SKIP" \
    | while IFS= read -r stale; do
        "$CLI" delete path="$stale"
      done
}

prune_pattern '^wiki/meta/lint-report-[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$'
prune_pattern '^wiki/meta/lint-data-[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$'
