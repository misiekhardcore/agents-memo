#!/usr/bin/env bash
# Regression: index-section-insert.sh splices after the FIRST occurrence of a
# duplicated heading (issue #195), warns on stderr when the section occurs
# more than once, and keeps the append-at-EOF fallback for absent headings.
#
# Hermetic: the obsidian CLI is stubbed into a scratch MEMO_PLUGIN_PWD and
# STUB_VAULT, so no Obsidian instance or real vault is touched. Write-back is
# byte-exact (`printf '%s'`), matching the script's `create overwrite=true`
# round-trip, so assertions compare the full file with `cmp`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSERT="$ROOT/scripts/index-section-insert.sh"

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Hermetic plugin + vault: the script resolves the CLI under
# ${MEMO_PLUGIN_PWD}/scripts/obsidian-cli.sh; the stub reads/writes
# ${STUB_VAULT}/<path> only.
export MEMO_PLUGIN_PWD="$SCRATCH/plugin"
export STUB_VAULT="$SCRATCH/vault"
mkdir -p "$MEMO_PLUGIN_PWD/scripts" "$STUB_VAULT/wiki"

cat > "$MEMO_PLUGIN_PWD/scripts/obsidian-cli.sh" <<'STUB'
#!/usr/bin/env bash
set -u
verb="${1:-}"
shift || true
path=""
content=""
for arg in "$@"; do
  case "$arg" in
    file=*)     path="${arg#file=}" ;;
    path=*)     path="${arg#path=}" ;;
    content=*)  content="${arg#content=}" ;;
    overwrite=*) : ;;
    *) : ;;  # upstream CLI ignores other arg=value pairs silently
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
  create)
    mkdir -p "$(dirname "$STUB_VAULT/$path")"
    printf '%s' "$content" > "$STUB_VAULT/$path"
    ;;
  *)
    echo "Error: Command \"$verb\" not found." >&2
    exit 1
    ;;
esac
STUB
chmod +x "$MEMO_PLUGIN_PWD/scripts/obsidian-cli.sh"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "[ok] $1"; }
bad() { FAIL=$((FAIL + 1)); echo "[FAIL] $1"; }

# Byte-exact file comparison: expected is built with printf so neither side
# carries an implicit trailing newline.
assert_file() {
  if printf '%s' "$2" | cmp -s - "$STUB_VAULT/$1"; then
    ok "$1 matches expected content"
  else
    bad "$1 differs from expected"
    echo "--- expected ---" >&2
    printf '%s\n' "$2" | sed 's/^/  /' >&2
    echo "--- actual ---" >&2
    sed 's/^/  /' "$STUB_VAULT/$1" >&2
  fi
}

ENTRY="- [[NEW]] — new"

echo ""
echo "=== regression/index-section-insert — #195 ==="

# 1. Duplicated heading → entry exactly once, immediately after the FIRST
#    heading, warning on stderr mentioning count and check #17.
cat > "$STUB_VAULT/wiki/index.md" <<'EOF'
# Index
## Concepts
- [[A]] — aaa
some prose
## Concepts
- [[B]] — bbb
EOF
ERR="$(bash "$INSERT" wiki/index.md "## Concepts" "$ENTRY" 2>&1 >/dev/null)" && RC=0 || RC=$?
if [ "$RC" -eq 0 ]; then ok "duplicate heading → exit 0"; else bad "duplicate heading → expected exit 0, got rc=$RC"; fi
EXPECTED="$(printf '%s\n' '# Index' '## Concepts' "$ENTRY" '- [[A]] — aaa' 'some prose' '## Concepts' '- [[B]] — bbb')"
assert_file wiki/index.md "$EXPECTED"
if [ "$(grep -cxF -- "$ENTRY" "$STUB_VAULT/wiki/index.md")" -eq 1 ]; then
  ok "entry appears exactly once"
else
  bad "entry should appear exactly once, got $(grep -cxF -- "$ENTRY" "$STUB_VAULT/wiki/index.md")"
fi
AFTER_FIRST="$(awk 'c { print; exit } /^## Concepts$/ { c=1 }' "$STUB_VAULT/wiki/index.md")"
if [ "$AFTER_FIRST" = "$ENTRY" ]; then
  ok "line after FIRST heading is the entry"
else
  bad "expected '$ENTRY' right after first heading, got '$AFTER_FIRST'"
fi
if printf '%s' "$ERR" | grep -q "occurs 2 times"; then
  ok "warning names occurrence count (2)"
else
  bad "warning missing 'occurs 2 times': $ERR"
fi
if printf '%s' "$ERR" | grep -q "check #17"; then
  ok "warning points at lint check #17"
else
  bad "warning missing 'check #17': $ERR"
fi

# 2. Single heading → entry once, newest-at-top within section, no warning.
cat > "$STUB_VAULT/wiki/index.md" <<'EOF'
# Index
## Concepts
- [[A]] — aaa
EOF
ERR="$(bash "$INSERT" wiki/index.md "## Concepts" "$ENTRY" 2>&1 >/dev/null)" && RC=0 || RC=$?
if [ "$RC" -eq 0 ]; then ok "single heading → exit 0"; else bad "single heading → expected exit 0, got rc=$RC"; fi
EXPECTED="$(printf '%s\n' '# Index' '## Concepts' "$ENTRY" '- [[A]] — aaa')"
assert_file wiki/index.md "$EXPECTED"
if [ -z "$ERR" ]; then
  ok "no warning on stderr"
else
  bad "unexpected stderr: $ERR"
fi

# 3. Absent heading → `## Sources` + entry appended as last two lines, no warning.
cat > "$STUB_VAULT/wiki/index.md" <<'EOF'
# Index
- [[A]] — aaa
EOF
ERR="$(bash "$INSERT" wiki/index.md "## Sources" "$ENTRY" 2>&1 >/dev/null)" && RC=0 || RC=$?
if [ "$RC" -eq 0 ]; then ok "absent heading → exit 0"; else bad "absent heading → expected exit 0, got rc=$RC"; fi
EXPECTED="$(printf '%s\n' '# Index' '- [[A]] — aaa' '' '## Sources' "$ENTRY")"
assert_file wiki/index.md "$EXPECTED"
LAST_TWO="$(tail -n 2 "$STUB_VAULT/wiki/index.md")"
if [ "$LAST_TWO" = "$(printf '%s\n' '## Sources' "$ENTRY")" ]; then
  ok "section + entry are the last two lines"
else
  bad "expected '## Sources' + entry at EOF, got: $LAST_TWO"
fi
if [ -z "$ERR" ]; then
  ok "no warning on stderr"
else
  bad "unexpected stderr: $ERR"
fi

echo ""
echo "=== summary ==="
echo "  pass=$PASS  fail=$FAIL"
[ "$FAIL" -eq 0 ]
