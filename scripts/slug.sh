#!/usr/bin/env bash
# slug.sh — Vault filename slug generator.
#
# Generates a 40-char-max slug from a title, with a body-derived fallback
# when the title slugifies to empty. Used by /memo-note (sub-issue #61) and the
# capture pipeline shared by /memo-daily and /memo-braindump (sub-issue #62).
#
# Usage:
#   slug.sh "<title>" [<fallback-body>]
#
# Output:
#   The slug to stdout (no date prefix, no .md extension, no collision suffix —
#   callers assemble the final filename and resolve same-day collisions).
#
# Exit codes:
#   0 — slug emitted
#   1 — title and fallback both slugify to empty
#   2 — argument error
#
# Slug rules (matches AC #1–#3, #5, #8 of issue #61):
#   1. Lowercase.
#   2. Non-alphanumerics → "-"; runs of "-" collapsed; leading/trailing "-" trimmed.
#   3. ≤ 40 chars: use whole.
#   4. > 40 chars: truncate at the last "-" before char 40 (word boundary).
#      If no "-" exists before char 40 (first word ≥ 40 chars), hard-truncate at 40.
#   5. Empty/whitespace after trimming AND a non-empty <fallback-body> given:
#      slugify the body, then hard-truncate to 40 (no word-boundary smarts —
#      bodies are user verbatim and may have no useful break points).

set -euo pipefail

slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

# truncate_at_word_boundary <slug> <max>
# Returns slug unchanged if ≤ max. Otherwise slices to max chars and strips
# any trailing partial word: ${head%-*} drops the shortest "-…" suffix, which
# either trims a trailing "-" or removes a half-cut last word. If no "-" is
# present in the head, the result equals the head — i.e. a hard truncation.
truncate_at_word_boundary() {
  local s="$1" max="$2"
  if [ "${#s}" -le "$max" ]; then
    printf '%s' "$s"
    return
  fi
  local head="${s:0:$max}"
  printf '%s' "${head%-*}"
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: slug.sh \"<title>\" [<fallback-body>]" >&2
  exit 2
fi

title="$1"
fallback="${2:-}"

slug="$(slugify "$title")"
if [ -n "$slug" ]; then
  truncate_at_word_boundary "$slug" 40
  exit 0
fi

if [ -n "$fallback" ]; then
  body_slug="$(slugify "$fallback")"
  if [ -n "$body_slug" ]; then
    printf '%s' "${body_slug:0:40}"
    exit 0
  fi
fi

echo "slug: title and fallback both slugify to empty" >&2
exit 1
