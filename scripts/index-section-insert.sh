#!/usr/bin/env bash
# index-section-insert.sh — insert an entry under a heading in a vault index file.
#
# Reads the target file via `obsidian read`, splices the entry on the line
# immediately after the FIRST matching heading (newest-at-top within the
# section), and writes back via `obsidian create overwrite=true`. If the
# heading occurs more than once, the entry is still inserted only after the
# first occurrence and a warning is printed to stderr — run /memo-lint
# (check #17) to find and fix the duplicate headings. If the heading is
# absent, appends `<heading>\n<entry>` at the end of the file.
#
# Used by /memo-save (skills/save/SKILL.md step 7) and /memo-wiki promote
# (skills/wiki/references/promote.md step 7) to maintain
# wiki/index.md without misplacing entries — `obsidian prepend` is
# whole-file, not section-aware.
#
# Usage:
#   index-section-insert.sh <vault-relative-path> <section-heading> <entry>
#
# Example:
#   index-section-insert.sh wiki/index.md "## Concepts" "- [[foo|Foo]] — bar"
#
# Exit codes:
#   0 — success
#   1 — argument error
#   * — propagated from obsidian-cli.sh (read/create failure)

set -euo pipefail

# Locate the plugin root. Under pi the extension rewrites ${MEMO_PLUGIN_PWD} into
# the command; under Claude Code it is unset, so fall back to script location.
MEMO_PLUGIN_PWD="${MEMO_PLUGIN_PWD:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export MEMO_PLUGIN_PWD

if [ "$#" -ne 3 ]; then
  echo "usage: index-section-insert.sh <path> <section> <entry>" >&2
  exit 1
fi

path="$1"
section="$2"
entry="$3"

cli="${MEMO_PLUGIN_PWD}/scripts/obsidian-cli.sh"

current=$("$cli" read "file=$path")

# Count exact-line matches first: with a duplicated heading we must insert
# only after the FIRST occurrence (newest-at-top), never after every one.
# `|| true` keeps `set -e` from aborting on grep's zero-match exit code.
count=$(printf '%s\n' "$current" | grep -cxF "$section" || true)

if [ "$count" -gt 0 ]; then
  updated=$(printf '%s\n' "$current" | awk -v h="$section" -v e="$entry" \
    '$0 == h && !seen { print; print e; seen = 1; next } { print }')
  if [ "$count" -gt 1 ]; then
    echo "index-section-insert: warning: section \"$section\" occurs $count times in $path; entry inserted after the first occurrence only. Run /memo-lint (check #17) to find and fix duplicate headings." >&2
  fi
else
  updated=$(printf '%s\n\n%s\n%s' "$current" "$section" "$entry")
fi

"$cli" create "path=$path" "overwrite=true" "content=$updated"
