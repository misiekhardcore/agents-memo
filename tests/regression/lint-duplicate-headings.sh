#!/usr/bin/env bash
# Regression: lint-scan.sh duplicate_headings producer (data source for lint
# check #17 — duplicate section headings).
#
# Hermetic: the obsidian CLI is stubbed into a scratch MEMO_PLUGIN_PWD and the
# vault is a scratch copy of tests/fixtures/lint-audit. A second `## Sources`
# heading is planted in the copy's wiki/index.md — no Obsidian instance or real
# vault is touched. Vault resolution itself is covered by pi-settings-tier.sh,
# so resolve-vault.sh is faked to print STUB_VAULT.
#
# Duplicate semantics are exact-line (## or deeper, full line match), same as
# check #7 / index-section-insert; near-duplicates (trailing space, level
# differences) are intentionally not flagged and are for manual review.
#
# Covers:
#   - duplicate heading detection: exactly the planted pair and planted triple
#   - single-occurrence headings are not flagged (implicit via length == 2)
#   - count > 2 semantics: a tripled heading emits count 3
#   - near-duplicates (trailing space, level difference) are NOT counted
#   - frontmatter / fenced-code heading pairs are excluded from counting
#   - empty-sections loop refactor: check #7 entry (concept-a.md) still produced
#   - determinism: data arrays byte-identical across two runs
#   - scan exit 0 and lint-data output written
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCAN="$ROOT/scripts/lint-scan.sh"

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Fixture root contains wiki/ and notes/; the vault root is the copy itself.
cp -r "$ROOT/tests/fixtures/lint-audit" "$SCRATCH/vault"

export MEMO_PLUGIN_PWD="$SCRATCH/plugin"
export STUB_VAULT="$SCRATCH/vault"
mkdir -p "$MEMO_PLUGIN_PWD/scripts"

# Stub the obsidian CLI: reads come from STUB_VAULT only; structural verbs
# (deadends/orphans/unresolved/backlinks) answer with empty/[] so the scan's
# data paths stay quiet.
cat > "$MEMO_PLUGIN_PWD/scripts/obsidian-cli.sh" <<'STUB'
#!/usr/bin/env bash
set -u
verb="${1:-}"
shift || true
path=""
for arg in "$@"; do
  case "$arg" in
    file=*)   path="${arg#file=}" ;;
    path=*)   path="${arg#path=}" ;;
    *)        : ;;  # format= and other arg=value pairs are ignored
  esac
done
case "$verb" in
  read)
    if [ -f "$STUB_VAULT/$path" ]; then
      cat "$STUB_VAULT/$path"
    else
      echo "Error: File \"$path\" not found." >&2
      exit 1
    fi
    ;;
  unresolved)
    echo '[]'
    ;;
  deadends|orphans)
    :
    ;;
  backlinks)
    echo '[]'
    ;;
  *)
    echo "Error: Command \"$verb\" not found." >&2
    exit 1
    ;;
esac
STUB
chmod +x "$MEMO_PLUGIN_PWD/scripts/obsidian-cli.sh"

# Fake vault resolution: lint-scan resolves the vault through this script;
# the resolution tiers are covered by pi-settings-tier.sh, not here.
cat > "$MEMO_PLUGIN_PWD/scripts/resolve-vault.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$STUB_VAULT"
STUB
chmod +x "$MEMO_PLUGIN_PWD/scripts/resolve-vault.sh"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "[ok] $1"; }
bad() { FAIL=$((FAIL + 1)); echo "[FAIL] $1"; }

# Plant the duplicate: the fixture index.md already has exactly one `## Sources`.
cat >> "$STUB_VAULT/wiki/index.md" <<'EOF'

## Sources
- [[newer-source]] — duplicate heading plant
EOF

# Plant headings that must NOT be counted as duplicates: a frontmatter pair
# and a fenced-code pair (excluded by the shared skip logic), a trailing-space
# near-duplicate and a level-difference near-duplicate (excluded by exact-line
# semantics), and a real tripled heading (count > 2 pinning).
cat > "$STUB_VAULT/wiki/concepts/fake-dups.md" <<'EOF'
---
type: concept
title: Fake Dups
## FmDup
## FmDup
---

# Fake Dups

Intro text.

```text
## FenceDup
## FenceDup
```

## NearDup
Content — this line and the trailing-space variant below are different exact
lines, so neither counts as a duplicate.

## NearDup 
Content — trailing-space variant of the heading above.

### LevelDup
Content — level-difference pair: ### vs ## are different exact lines.

## LevelDup
Content — ## variant of the heading above.

## Trip
Content one.

## Trip
Content two.

## Trip
Content three.

## RealSingle

This section has content, so it is not an empty-section false positive either.
EOF

echo ""
echo "=== regression/lint-duplicate-headings ==="

OUT_FILE="$STUB_VAULT/wiki/meta/lint-data-$(date +%F).json"
OUT="$(bash "$SCAN" 2>&1)" && RC=0 || RC=$?

# 1. Scan exits 0 and writes the output file.
if [ "$RC" -eq 0 ]; then
  ok "scan exits 0"
else
  bad "scan expected exit 0, got rc=$RC: $OUT"
fi
if [ -f "$OUT_FILE" ]; then
  ok "lint-data file written"
else
  bad "missing output file $OUT_FILE"
fi

# 2. duplicate_headings: exactly the planted pair and the planted triple
#    (length == 2 also proves the fixture's single-occurrence ## Concepts /
#    ## Entities are not flagged). any() keeps the assertions independent of
#    the sort_by(.source_page, .heading) key order.
if jq -e '.duplicate_headings | length == 2' "$OUT_FILE" >/dev/null 2>&1; then
  ok "exactly two duplicate-heading entries"
else
  bad "expected exactly 2 duplicate_headings entries, got: $(jq -c '.duplicate_headings' "$OUT_FILE" 2>/dev/null)"
fi
if jq -e '.duplicate_headings | any(.source_page == "wiki/index.md" and .heading == "## Sources" and .count == 2)' "$OUT_FILE" >/dev/null 2>&1; then
  ok "duplicate pair is {wiki/index.md, ## Sources, count 2}"
else
  bad "missing expected pair entry: $(jq -c '.duplicate_headings' "$OUT_FILE" 2>/dev/null)"
fi
if jq -e '.duplicate_headings | any(.source_page == "wiki/concepts/fake-dups.md" and .heading == "## Trip" and .count == 3)' "$OUT_FILE" >/dev/null 2>&1; then
  ok "tripled heading emits count 3 {fake-dups.md, ## Trip, count 3}"
else
  bad "missing expected triple entry: $(jq -c '.duplicate_headings' "$OUT_FILE" 2>/dev/null)"
fi

# 3. Near-duplicates (trailing space, level difference) are NOT counted —
#    exact-line duplicate semantics locked in. rtrimstr() makes the check
#    catch the trailing-space variant even though its full heading line
#    differs from the assertion string.
if jq -e '.duplicate_headings | all((.heading | rtrimstr(" ")) != "## NearDup")' "$OUT_FILE" >/dev/null 2>&1; then
  ok "trailing-space near-duplicate not counted"
else
  bad "trailing-space near-duplicate ## NearDup* was flagged: $(jq -c '.duplicate_headings' "$OUT_FILE" 2>/dev/null)"
fi
if jq -e '.duplicate_headings | all(.heading != "### LevelDup")' "$OUT_FILE" >/dev/null 2>&1; then
  ok "level-difference near-duplicate not counted"
else
  bad "level-difference ##/### LevelDup was flagged: $(jq -c '.duplicate_headings' "$OUT_FILE" 2>/dev/null)"
fi

# 4. Empty-sections loop refactor regression: concept-a's `## Details` still
#    flagged (check #7).
if jq -e '.empty_sections | any(.source_page == "wiki/concepts/concept-a.md")' "$OUT_FILE" >/dev/null 2>&1; then
  ok "empty_sections still flags concept-a.md (check #7)"
else
  bad "empty_sections lost concept-a.md: $(jq -c '.empty_sections' "$OUT_FILE" 2>/dev/null)"
fi

# 5. Frontmatter / fenced-code heading pairs are excluded from duplicate
#    counting (planted in fake-dups.md).
if jq -e '.duplicate_headings | all(.heading != "## FmDup")' "$OUT_FILE" >/dev/null 2>&1; then
  ok "frontmatter ## FmDup pair not counted"
else
  bad "frontmatter headings leaked: $(jq -c '.duplicate_headings' "$OUT_FILE" 2>/dev/null)"
fi
if jq -e '.duplicate_headings | all(.heading != "## FenceDup")' "$OUT_FILE" >/dev/null 2>&1; then
  ok "fenced ## FenceDup pair not counted"
else
  bad "fenced headings leaked: $(jq -c '.duplicate_headings' "$OUT_FILE" 2>/dev/null)"
fi

# 6. Determinism: two runs produce identical data arrays (the scan overwrites
#    the same dated file, so snapshot run 1 before re-running).
RUN1="$OUT_FILE.run1"
cp "$OUT_FILE" "$RUN1"
if bash "$SCAN" >/dev/null 2>&1; then
  ok "second scan run exits 0"
else
  bad "second scan run failed"
fi
PROJ='{dead_links, orphans, unresolved_targets, anti_patterns, empty_sections, duplicate_headings, backlinks}'
A="$(jq -Sc "$PROJ" "$RUN1")"
B="$(jq -Sc "$PROJ" "$OUT_FILE")"
if [ "$A" = "$B" ]; then
  ok "data arrays identical across two runs"
else
  bad "nondeterminism between runs: run1=$A run2=$B"
fi

echo ""
echo "=== summary ==="
echo "  pass=$PASS  fail=$FAIL"
[ "$FAIL" -eq 0 ]
