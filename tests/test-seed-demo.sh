#!/usr/bin/env bash
# Tests for bin/seed-demo.sh
# Usage: bash tests/test-seed-demo.sh

set -euo pipefail

PASS=0
FAIL=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SEED_SCRIPT="$PLUGIN_ROOT/bin/seed-demo.sh"

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

assert_file_exists() {
  local vault="$1" relpath="$2"
  [ -f "$vault/$relpath" ] && pass "file exists: $relpath" || fail "missing: $relpath"
}

assert_file_not_newer() {
  local file="$1" mtime_before="$2"
  local mtime_after
  mtime_after=$(stat -c %Y "$file" 2>/dev/null || stat -f %m "$file")
  [ "$mtime_after" -eq "$mtime_before" ] \
    && pass "idempotent: file unchanged: $(basename "$file")" \
    || fail "file was overwritten: $(basename "$file")"
}

assert_contains() {
  local file="$1" pattern="$2"
  grep -q "$pattern" "$file" && pass "contains '$pattern' in $(basename "$file")" \
    || fail "missing '$pattern' in $(basename "$file")"
}

echo ""
echo "=== test-seed-demo.sh ==="

# ── Test 1: Fresh vault ──────────────────────────────────────────────────────
echo ""
echo "1. Fresh vault — all expected files are created"
VAULT=$(mktemp -d)
trap 'rm -rf "$VAULT"' EXIT

export MEMO_PLUGIN_PWD="$PLUGIN_ROOT"
mkdir -p "$VAULT/wiki/concepts" "$VAULT/wiki/entities" "$VAULT/wiki/sources" "$VAULT/wiki/questions"

bash "$SEED_SCRIPT" "$VAULT"

assert_file_exists "$VAULT" "wiki/index.md"
assert_file_exists "$VAULT" "wiki/hot.md"
assert_file_exists "$VAULT" "wiki/log.md"
assert_file_exists "$VAULT" "wiki/overview.md"
assert_file_exists "$VAULT" "wiki/concepts/example-concept.md"
assert_file_exists "$VAULT" "wiki/entities/example-entity.md"
assert_file_exists "$VAULT" "wiki/sources/example-source.md"
assert_file_exists "$VAULT" "wiki/questions/example-question.md"
assert_file_exists "$VAULT" "FIRST_RUN.md"

# ── Test 2: Frontmatter schema ───────────────────────────────────────────────
echo ""
echo "2. Frontmatter schema — required fields present"
for f in example-concept example-entity example-source example-question; do
  dir=$(echo "$f" | sed 's/example-//')
  case "$dir" in concept) dir="concepts";; entity) dir="entities";; source) dir="sources";; question) dir="questions";; esac
  assert_contains "$VAULT/wiki/$dir/$f.md" "^type:"
  assert_contains "$VAULT/wiki/$dir/$f.md" "^title:"
  assert_contains "$VAULT/wiki/$dir/$f.md" "^created:"
  assert_contains "$VAULT/wiki/$dir/$f.md" "^status:"
  assert_contains "$VAULT/wiki/$dir/$f.md" "^confidence:"
done

# ── Test 3: Cross-links ──────────────────────────────────────────────────────
echo ""
echo "3. Cross-links — each example links to at least one other"
assert_contains "$VAULT/wiki/concepts/example-concept.md" "\[\["
assert_contains "$VAULT/wiki/entities/example-entity.md" "\[\["
assert_contains "$VAULT/wiki/sources/example-source.md" "\[\["
assert_contains "$VAULT/wiki/questions/example-question.md" "\[\["

# ── Test 3b: Date substitution ────────────────────────────────────────────────
echo ""
echo "3b. {{today}} placeholder is substituted with actual date"
TODAY=$(date +%Y-%m-%d)
for f in wiki/index.md wiki/hot.md wiki/log.md wiki/overview.md; do
  if grep -q "{{today}}" "$VAULT/$f"; then
    fail "unsubstituted {{today}} in $f"
  else
    pass "no unsubstituted placeholder in $f"
  fi
  assert_contains "$VAULT/$f" "$TODAY"
done

# ── Test 4: Idempotency ──────────────────────────────────────────────────────
echo ""
echo "4. Idempotency — re-run does not overwrite existing files"
CONCEPT_FILE="$VAULT/wiki/concepts/example-concept.md"
SENTINEL="idempotency-test-sentinel-12345"
echo "$SENTINEL" >> "$CONCEPT_FILE"
mtime_before=$(stat -c %Y "$CONCEPT_FILE" 2>/dev/null || stat -f %m "$CONCEPT_FILE")
sleep 1
bash "$SEED_SCRIPT" "$VAULT"
assert_contains "$CONCEPT_FILE" "$SENTINEL"
assert_file_not_newer "$CONCEPT_FILE" "$mtime_before"

# ── Test 5: No vault path ────────────────────────────────────────────────────
echo ""
echo "5. Missing vault path — exits 0 with guidance"
output=$(bash "$SEED_SCRIPT" "" 2>&1)
exit_code=$?
[ $exit_code -eq 0 ] && pass "exits 0 when no vault path" || fail "non-zero exit without vault path"
echo "$output" | grep -qi "vault" && pass "prints vault guidance" || fail "no vault guidance in output"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ $FAIL -eq 0 ] && exit 0 || exit 1
