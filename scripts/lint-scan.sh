#!/usr/bin/env bash
# lint-scan.sh — deterministic lint data producer.
#
# Runs a single deterministic pass: invokes obsidian deadends, unresolved,
# orphans; parses canvas JSON for wikilinks; pre-computes backlinks for every
# in-scope page. Writes wiki/meta/lint-data-YYYY-MM-DD.json.
#
# Two runs on an unchanged vault produce byte-identical output (excluding scan_date).
# Ordering guarantee: all enumeration arrays are sorted before writing JSON.
#
# Usage:
#   MEMO_PLUGIN_PWD=/path/to/plugin lint-scan.sh
#
# Env:
#   MEMO_PLUGIN_PWD — optional; defaults to the plugin root derived from the
#   script location (under pi the extension rewrites ${MEMO_PLUGIN_PWD} into
#   the command; under Claude Code it is unset).
#
# Exit codes:
#   0 — success
#   1 — CLI error or dependency failure

set -euo pipefail

# Locate the plugin root. Under pi the extension rewrites ${MEMO_PLUGIN_PWD} into
# the command; under Claude Code it is unset, so fall back to script location.
MEMO_PLUGIN_PWD="${MEMO_PLUGIN_PWD:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export MEMO_PLUGIN_PWD

command -v jq >/dev/null 2>&1 || { echo "lint-scan: jq is required" >&2; exit 1; }

CLI="${MEMO_PLUGIN_PWD}/scripts/obsidian-cli.sh"
VAULT="$("${MEMO_PLUGIN_PWD}/scripts/resolve-vault.sh")" || {
  echo "lint-scan: could not resolve vault" >&2; exit 1
}
TODAY=$(date +%F)
OUTPUT_PATH="${VAULT}/wiki/meta/lint-data-${TODAY}.json"

# ─── Scope definition ─────────────────────────────────────────────────────────
# Single source of truth for what is scanned. Two runs on the same vault state
# use exactly these inputs and produce the same output.

SCANNED_DIRS=(
  "wiki/concepts"
  "wiki/entities"
  "wiki/sources"
  "wiki/domains"
  "wiki/comparisons"
  "wiki/questions"
  "wiki/solutions"
)
SCANNED_SINGLES=("wiki/index.md" "wiki/log.md" "wiki/hot.md")
CANVAS_DIR="wiki/canvases"

scope_json=$(jq -n \
  --argjson scanned_dirs    "$(printf '%s\n' "${SCANNED_DIRS[@]}" | jq -R . | jq -s .)" \
  --argjson scanned_singles "$(printf '%s\n' "${SCANNED_SINGLES[@]}" | jq -R . | jq -s .)" \
  --arg     canvas_dir      "$CANVAS_DIR" \
  --argjson excluded_dirs   '["wiki/meta","wiki/trails","notes","_archive","_templates",".raw"]' \
  --argjson ext_source      '["md","canvas"]' \
  --argjson ext_target      '["md","canvas","base","png","jpg","jpeg","svg","pdf"]' \
  '{
    scanned_dirs:      $scanned_dirs,
    scanned_singles:   $scanned_singles,
    canvas_dir:        $canvas_dir,
    excluded_dirs:     $excluded_dirs,
    extensions_source: $ext_source,
    extensions_target: $ext_target
  }')

# ─── Enumerate in-scope .md pages (sorted) ────────────────────────────────────
md_pages=()
for dir in "${SCANNED_DIRS[@]}"; do
  while IFS= read -r p; do
    md_pages+=("$p")
  done < <(
    find "${VAULT}/${dir}" -maxdepth 3 -name "*.md" 2>/dev/null \
      | sed "s|^${VAULT}/||" \
      | sort
  )
done
for p in "${SCANNED_SINGLES[@]}"; do
  [[ -f "${VAULT}/${p}" ]] && md_pages+=("$p")
done

# ─── Unresolved targets (obsidian's resolver is authoritative) ─────────────────
unresolved_list=()
while IFS= read -r link; do
  unresolved_list+=("$link")
done < <(
  "$CLI" unresolved format=json 2>/dev/null \
    | jq -r '.[].link' \
    | sort -u
)

declare -A unresolved_set
for link in "${unresolved_list[@]}"; do
  unresolved_set["$link"]=1
done

# ─── Dead links from .md sources ─────────────────────────────────────────────
# obsidian deadends gives source pages; we read each to find specific broken links.

dead_source_pages=()
while IFS= read -r p; do
  dead_source_pages+=("$p")
done < <(
  "$CLI" deadends 2>/dev/null \
    | grep -v '^wiki/trails/' \
    | grep -v '^wiki/meta/' \
    | grep -v '^notes/' \
    | grep -v '^_archive/' \
    | grep -v '^_templates/' \
    | sort
)

dead_links_entries=()
for source_page in "${dead_source_pages[@]}"; do
  content=$("$CLI" read "path=${source_page}" 2>/dev/null) || continue
  while IFS= read -r wikilink; do
    # Strip pipe-alias: [[Target|Display]] → Target
    link_target="${wikilink%%|*}"
    if [[ -n "${unresolved_set[$link_target]+_}" ]]; then
      dead_links_entries+=(
        "$(jq -n --arg sp "$source_page" --arg lt "$link_target" \
             '{source_page: $sp, link_text: $lt}')"
      )
    fi
  done < <(grep -oP '(?<=\[\[)[^\]]+(?=\]\])' <<< "$content" 2>/dev/null | sort -u)
done

# ─── Canvas dead links and anti-patterns ──────────────────────────────────────
# Canvas files are JSON; wikilinks live in node text fields. obsidian's CLI
# verbs (deadends, unresolved) do not cover canvas, so we parse files directly.
# Documented bypass: canvas JSON requires direct file reads because no structured
# CLI verb exists for canvas wikilink extraction (see _shared/cli.md §6).

# Build resolver pool from filesystem (basenames without extension).
# Used only for canvas link verification; .md dead-link checking uses obsidian unresolved.
# Pool includes .base as a valid target type (Obsidian Bases files are linkable) but .base
# files are not scanned for outbound wikilinks — they are data tables, not narrative pages.
declare -A resolver_pool
while IFS= read -r f; do
  base=$(basename "$f"); name="${base%.*}"
  resolver_pool["$name"]=1
done < <(
  find "$VAULT" \
    \( -path "${VAULT}/.obsidian" -prune \) -o \
    \( -name "*.md" -o -name "*.canvas" -o -name "*.base" \
       -o -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" \
       -o -name "*.svg" -o -name "*.pdf" \) -print \
    2>/dev/null | sort
)

canvas_dead_entries=()
canvas_anti_entries=()

if [ -d "${VAULT}/${CANVAS_DIR}" ]; then
  while IFS= read -r canvas_file; do
    rel_path="${canvas_file#${VAULT}/}"
    while IFS= read -r wikilink; do
      if [[ "$wikilink" =~ ^https?:// ]]; then
        canvas_anti_entries+=(
          "$(jq -n --arg sp "$rel_path" --arg lt "$wikilink" \
               '{source_page: $sp, link_text: $lt}')"
        )
      else
        link_target="${wikilink%%|*}"
        if [[ -z "${resolver_pool[$link_target]+_}" ]]; then
          canvas_dead_entries+=(
            "$(jq -n --arg sp "$rel_path" --arg lt "$link_target" \
                 '{source_page: $sp, link_text: $lt}')"
          )
        fi
      fi
    done < <(
      jq -r '.nodes[]?.text // empty' "$canvas_file" 2>/dev/null \
        | grep -oP '(?<=\[\[)[^\]]+(?=\]\])' \
        | sort -u
    )
  done < <(find "${VAULT}/${CANVAS_DIR}" -name '*.canvas' 2>/dev/null | sort)  # sort: determinism
fi

# ─── Anti-patterns: URL-as-wikilink in .md pages ─────────────────────────────
# Anti-patterns are reported per source-page occurrence, not deduplicated across the vault.
# This matches the dead-links semantics: each broken wikilink is its own finding.
md_anti_entries=()
for page in "${md_pages[@]}"; do
  content=$("$CLI" read "path=${page}" 2>/dev/null) || continue
  while IFS= read -r wikilink; do
    if [[ "$wikilink" =~ ^https?:// ]]; then
      md_anti_entries+=(
        "$(jq -n --arg sp "$page" --arg lt "$wikilink" \
             '{source_page: $sp, link_text: $lt}')"
      )
    fi
  done < <(grep -oP '(?<=\[\[)[^\]]+(?=\]\])' <<< "$content" 2>/dev/null | sort -u)
done

# ─── Empty sections + duplicate headings ────────────────────────────────────
# A heading (## or deeper) is empty when the next non-blank line is another
# heading or there are no further non-blank lines. Frontmatter and code blocks
# are excluded so fenced content can't produce false positives.
# Duplicate headings are counted in the same pass (same heading-line semantics
# as check #7 and the index-section-insert script: exact line, ## or deeper).

empty_sections_entries=()
duplicate_headings_entries=()
for page in "${md_pages[@]}"; do
  content=$("$CLI" read "path=${page}" 2>/dev/null) || continue

  in_frontmatter=false
  in_code_block=false
  prev_heading=""
  saw_content=false
  first_line=true
  declare -A page_heading_counts=()

  while IFS= read -r line; do
    if $first_line; then
      first_line=false
      if [[ "$line" == "---" ]]; then in_frontmatter=true; continue; fi
    fi
    if $in_frontmatter; then
      [[ "$line" == "---" || "$line" == "..." ]] && in_frontmatter=false
      continue
    fi
    if [[ "$line" =~ ^(\`\`\`|~~~) ]]; then
      $in_code_block && in_code_block=false || in_code_block=true
      saw_content=true; continue
    fi
    if $in_code_block; then saw_content=true; continue; fi

    if [[ "$line" =~ ^#{2,}[[:space:]] ]]; then
      if [[ -n "$prev_heading" ]] && ! $saw_content; then
        empty_sections_entries+=(
          "$(jq -n --arg p "$page" --arg h "$prev_heading" \
               '{source_page: $p, heading: $h}')"
        )
      fi
      prev_heading="$line"; saw_content=false
      page_heading_counts["$line"]=$(( ${page_heading_counts["$line"]:-0} + 1 ))
    elif [[ -n "${line// }" ]]; then
      saw_content=true
    fi
  done <<< "$content"

  if [[ -n "$prev_heading" ]] && ! $saw_content; then
    empty_sections_entries+=(
      "$(jq -n --arg p "$page" --arg h "$prev_heading" \
           '{source_page: $p, heading: $h}')"
    )
  fi

  # Empty-map guard: `${!map[@]}` on an empty associative array is an unbound-
  # variable error under `set -u` on bash 4.0-4.3 (safe on 4.4+; kept for
  # portability and to avoid needless map expansion on heading-less pages).
  if [[ ${#page_heading_counts[@]} -gt 0 ]]; then
    for h in "${!page_heading_counts[@]}"; do
      c=${page_heading_counts["$h"]}
      if [ "$c" -gt 1 ]; then
        duplicate_headings_entries+=(
          "$(jq -n --arg p "$page" --arg h "$h" --argjson c "$c" \
               '{source_page: $p, heading: $h, count: $c}')"
        )
      fi
    done
  fi
done

# ─── Orphans ─────────────────────────────────────────────────────────────────
orphans_list=()
while IFS= read -r p; do
  orphans_list+=("$p")
done < <(
  "$CLI" orphans 2>/dev/null \
    | grep -v '^wiki/trails/' \
    | grep -v '^notes/' \
    | grep -v '^wiki/meta/' \
    | sort
)

# ─── Backlinks pre-computation ────────────────────────────────────────────────
# One obsidian CLI call per in-scope page — replaces the ~N in-loop calls
# the agent previously made during check #10.

scope_pages=("${md_pages[@]}")
if [ -d "${VAULT}/${CANVAS_DIR}" ]; then
  while IFS= read -r f; do
    scope_pages+=("${f#${VAULT}/}")
  done < <(find "${VAULT}/${CANVAS_DIR}" -name '*.canvas' 2>/dev/null | sort)
fi

declare -A backlink_counts
for page in "${scope_pages[@]}"; do
  raw=$("$CLI" backlinks "path=${page}" format=json 2>/dev/null) || true
  count=$(jq 'length' <<< "${raw:-[]}" 2>/dev/null) || count=0
  backlink_counts["$page"]="${count:-0}"
done

# ─── Assemble JSON ────────────────────────────────────────────────────────────

# dead_links: merge .md and canvas entries, sort for determinism
all_dead=("${dead_links_entries[@]}" "${canvas_dead_entries[@]}")
if [[ ${#all_dead[@]} -gt 0 ]]; then
  dead_links_json=$(printf '%s\n' "${all_dead[@]}" \
    | jq -s 'sort_by(.source_page, .link_text)')
else
  dead_links_json='[]'
fi

if [[ ${#orphans_list[@]} -gt 0 ]]; then
  orphans_json=$(printf '%s\n' "${orphans_list[@]}" | jq -R . | jq -s '.')
else
  orphans_json='[]'
fi

if [[ ${#unresolved_list[@]} -gt 0 ]]; then
  unresolved_json=$(printf '%s\n' "${unresolved_list[@]}" | jq -R '{link: .}' | jq -s '.')
else
  unresolved_json='[]'
fi

all_anti=("${md_anti_entries[@]}" "${canvas_anti_entries[@]}")
if [[ ${#all_anti[@]} -gt 0 ]]; then
  anti_json=$(printf '%s\n' "${all_anti[@]}" \
    | jq -s 'sort_by(.source_page, .link_text)')
else
  anti_json='[]'
fi

if [[ ${#empty_sections_entries[@]} -gt 0 ]]; then
  empty_sections_json=$(printf '%s\n' "${empty_sections_entries[@]}" \
    | jq -s 'sort_by(.source_page, .heading)')
else
  empty_sections_json='[]'
fi

if [[ ${#duplicate_headings_entries[@]} -gt 0 ]]; then
  duplicate_headings_json=$(printf '%s\n' "${duplicate_headings_entries[@]}" \
    | jq -s 'sort_by(.source_page, .heading)')
else
  duplicate_headings_json='[]'
fi

if [[ ${#backlink_counts[@]} -eq 0 ]]; then
  backlinks_json='{}'
else
  backlinks_json=$(
    {
      while IFS= read -r key; do
        jq -n --arg k "$key" --argjson v "${backlink_counts[$key]:-0}" '{($k): $v}'
      done < <(printf '%s\n' "${!backlink_counts[@]}" | sort)
    } | jq -s 'add // {}'
  )
fi

# vault commit hash (best-effort)
vault_commit=""
if git -C "$VAULT" rev-parse HEAD >/dev/null 2>&1; then
  vault_commit=$(git -C "$VAULT" rev-parse HEAD 2>/dev/null)
fi

output=$(jq -n \
  --arg     scan_date          "$TODAY" \
  --arg     vault_commit       "$vault_commit" \
  --argjson scope              "$scope_json" \
  --argjson dead_links         "$dead_links_json" \
  --argjson orphans            "$orphans_json" \
  --argjson unresolved_targets "$unresolved_json" \
  --argjson anti_patterns      "$anti_json" \
  --argjson empty_sections     "$empty_sections_json" \
  --argjson duplicate_headings "$duplicate_headings_json" \
  --argjson backlinks          "$backlinks_json" \
  '{
    scan_date:           $scan_date,
    vault_commit:        $vault_commit,
    scope:               $scope,
    dead_links:          $dead_links,
    orphans:             $orphans,
    unresolved_targets:  $unresolved_targets,
    anti_patterns:       $anti_patterns,
    empty_sections:      $empty_sections,
    duplicate_headings:  $duplicate_headings,
    backlinks:           $backlinks
  }')

# Write directly to filesystem — documented bypass: lint-data JSON is administrative
# bookkeeping (same exception class as .raw/.manifest.json; see _shared/cli.md §6).
# content= would corrupt embedded \n sequences (see _shared/cli.md §3 escape asymmetry).
mkdir -p "$(dirname "$OUTPUT_PATH")"
printf '%s\n' "$output" > "$OUTPUT_PATH"

echo "lint-scan: wrote wiki/meta/lint-data-${TODAY}.json"
