#!/usr/bin/env bash
# Local full-tier entrypoint. Exercises the LLM path:
#   vault registration → /wiki init → ingest → /daily ×3 → /daily-close
# Shape-only assertions throughout. Sequence per #89 Section C.
#
# Requires mounts:
#   /opt/plugin-src                       plugin working tree (read-only)
#   /root/.claude/.credentials.json       ~/.claude/.credentials.json (read-only)
#
# Credentials are mounted at the path the `claude` CLI consults natively
# (HOME=/root inside the container), so OAuth or API-key auth is picked up
# without an env-var hop. The entrypoint verifies the file is readable and
# carries one of the two accepted shapes; it never extracts the secret.
#
# AC3: mounts + credentials verified before any docker/LLM work.
# AC8: all-pass → exit 0, container removed (--rm by caller).
# AC9: failure → artifacts dumped to stderr → exit non-zero.
# AC14: 180s timeout per claude -p call.

set -euo pipefail

PLUGIN_SRC="${PLUGIN_SRC:-/opt/plugin-src}"
CREDENTIALS="${CREDENTIALS:-/root/.claude/.credentials.json}"
VAULT_PATH="${VAULT_PATH:-/tmp/vault}"
DISPLAY_NUM="${DISPLAY_NUM:-:99}"

# ── State for AC9 artifact capture ───────────────────────────────────────────
LAST_CMD=""
CLAUDE_OUTPUT=""
OBSIDIAN_PID=""
XVFB_PID=""

dump_artifacts() {
  echo "" >&2
  echo "=== E2E failure artifacts ===" >&2
  echo "Obsidian log (/tmp/obsidian.log — last 50 lines):" >&2
  tail -50 /tmp/obsidian.log 2>/dev/null | sed 's/^/  /' >&2 || true
  echo "" >&2
  if [ -n "$LAST_CMD" ]; then
    echo "Last claude -p: $LAST_CMD" >&2
    echo "Output (first 500 chars):" >&2
    printf '%s' "$CLAUDE_OUTPUT" | head -c 500 | sed 's/^/  /' >&2 || true
    echo "" >&2
  fi
  DAILY_FILE="$VAULT_PATH/daily/$(date +%F).md"
  if [ -f "$DAILY_FILE" ]; then
    echo "Daily file ($DAILY_FILE):" >&2
    sed 's/^/  /' "$DAILY_FILE" >&2 || true
    echo "" >&2
  fi
}

safe_rm_vault() {
  # Refuse to rm anything outside /tmp/ to protect against a misconfigured
  # VAULT_PATH (env override) wiping the host root or another mount.
  case "$VAULT_PATH" in
    /tmp/?*) rm -rf "$VAULT_PATH" 2>/dev/null || true ;;
    *) echo "entrypoint-local: refusing to rm VAULT_PATH=$VAULT_PATH (must be under /tmp/)" >&2 ;;
  esac
}

cleanup() {
  local rc=$?
  [ $rc -ne 0 ] && dump_artifacts || true
  [ -n "$OBSIDIAN_PID" ] && kill "$OBSIDIAN_PID" 2>/dev/null || true
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null || true
  [ -n "${DBUS_SESSION_BUS_PID:-}" ] && kill "$DBUS_SESSION_BUS_PID" 2>/dev/null || true
  safe_rm_vault
  exit $rc
}
trap cleanup EXIT INT TERM

# ── Step 1: Verify mounts ─────────────────────────────────────────────────────
if [ ! -d "$PLUGIN_SRC" ]; then
  echo "entrypoint-local: plugin source not mounted at $PLUGIN_SRC" >&2
  exit 2
fi
if [ ! -r "$PLUGIN_SRC/bin/setup-vault.sh" ]; then
  echo "entrypoint-local: $PLUGIN_SRC/bin/setup-vault.sh missing or not readable" >&2
  exit 2
fi
if [ ! -r "$CREDENTIALS" ]; then
  echo "entrypoint-local: credentials not mounted at $CREDENTIALS" >&2
  exit 2
fi

# ── Step 2: Validate credentials shape ───────────────────────────────────────
# Accept either an OAuth login (`claudeAiOauth.accessToken`) or a legacy API
# key (`api_key`). The `claude` CLI reads the file directly at this path —
# we only assert one of the two fields is a non-empty string before
# exercising the LLM, so misconfigured credentials fail here instead of
# producing an opaque 401 mid-run.
if ! jq -e '(.claudeAiOauth.accessToken // .api_key) | type == "string" and length > 0' \
      "$CREDENTIALS" >/dev/null 2>&1; then
  echo "entrypoint-local: $CREDENTIALS has neither a non-empty claudeAiOauth.accessToken nor a non-empty api_key" >&2
  exit 2
fi
echo "entrypoint-local: credentials validated"

# ── Step 3: Create vault dir ──────────────────────────────────────────────────
case "$VAULT_PATH" in
  /tmp/?*) ;;
  *) echo "entrypoint-local: refusing to operate on VAULT_PATH=$VAULT_PATH (must be under /tmp/)" >&2; exit 2 ;;
esac
rm -rf "$VAULT_PATH"
mkdir -p "$VAULT_PATH"
echo "entrypoint-local: vault at $VAULT_PATH"

# ── Step 4: Scaffold vault dirs ───────────────────────────────────────────────
echo "entrypoint-local: scaffolding vault"
MEMO_PLUGIN_PWD="$PLUGIN_SRC" bash "$PLUGIN_SRC/bin/setup-vault.sh" "$VAULT_PATH"

# Seed wiki/hot.md so the readiness probe (obsidian read path=wiki/hot.md) can
# succeed before /wiki init runs. hot.md links to index.md for the backlinks
# probe in cli-smoke.sh (AC3).
if [ ! -f "$VAULT_PATH/wiki/hot.md" ]; then
  cat > "$VAULT_PATH/wiki/hot.md" <<'EOF'
# Hot cache

See [[index]] for the wiki entrypoint.
EOF
fi
[ -f "$VAULT_PATH/wiki/index.md" ] || echo "# Wiki index" > "$VAULT_PATH/wiki/index.md"

# ── Step 5: Register vault ────────────────────────────────────────────────────
bash /e2e/register-vault.sh "$VAULT_PATH"

# ── Step 6: Boot Xvfb + D-Bus + Obsidian ─────────────────────────────────────
echo "entrypoint-local: starting Xvfb on $DISPLAY_NUM"
Xvfb "$DISPLAY_NUM" -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
export DISPLAY="$DISPLAY_NUM"
sleep 1

echo "entrypoint-local: starting D-Bus session"
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID

echo "entrypoint-local: launching Obsidian GUI"

launch_obsidian() {
  APPDIR=/opt/Obsidian /opt/Obsidian/AppRun \
      --no-sandbox \
      --disable-gpu \
      --disable-dev-shm-usage \
      >>/tmp/obsidian.log 2>&1 &
  OBSIDIAN_PID=$!
}

launch_obsidian
# Defensive retry: rare Chromium SIGTRAP during first launch after a cold image
# build. If the process dies in the first 3s, relaunch once before the 60s
# readiness probe decides the outcome.
sleep 3
if ! kill -0 "$OBSIDIAN_PID" 2>/dev/null; then
  echo "entrypoint-local: Obsidian process died during init; relaunching once"
  launch_obsidian
fi

# ── Step 7: Readiness probe (AC13: 60s cap) ───────────────────────────────────
if ! bash /e2e/wait-for-obsidian.sh; then
  echo "entrypoint-local: readiness probe failed; tail of Obsidian log:" >&2
  tail -100 /tmp/obsidian.log >&2 || true
  exit 1
fi

# ── Claude -p wrapper with 180s timeout (AC14) ───────────────────────────────
# `--allowedTools` whitelist replaces `--dangerously-skip-permissions`, which
# refuses to run as root (the container's only user). The list covers what the
# skills exercise in the E2E flow: vault file I/O via the Obsidian CLI (Bash),
# and direct file ops the wiki/daily skills perform on the vault tree.
run_claude() {
  local cmd="$1"
  LAST_CMD="$cmd"
  local tmp; tmp=$(mktemp)
  local rc=0
  # `--` terminates flag parsing so the variadic `--allowedTools <tools...>`
  # stops consuming positional args before the prompt.
  timeout 180 claude -p \
      --allowedTools 'Bash Edit Write Read Glob Grep' \
      -- "$cmd" 2>&1 | tee "$tmp" || rc=$?
  CLAUDE_OUTPUT=$(cat "$tmp")
  rm -f "$tmp"
  if [ $rc -eq 124 ]; then
    echo "entrypoint-local: TIMEOUT — claude -p exceeded 180s: $cmd" >&2
    exit 1
  fi
  return $rc
}

# ── Step 8a: /wiki init → vault-shape assertion (AC4) ────────────────────────
# Plugin slash commands are namespaced as `/<plugin-name>:<command>` until
# the plugin manifest declares the `commands` field that registers bare
# aliases. The harness uses the namespaced form so the test doesn't depend
# on bare-alias support landing first.
echo ""
echo "entrypoint-local: step 8a — /agents-memo:wiki init"
run_claude "/agents-memo:wiki init"
bash /e2e/assertions/vault-shape.sh "$VAULT_PATH"

# ── Step 8b: ingest fixture → frontmatter + index-mutated assertions (AC5) ───
echo ""
echo "entrypoint-local: step 8b — ingest fixture"
cp /e2e/fixtures/sample.md "$VAULT_PATH/.raw/sample.md"

SOURCES_BEFORE=$(ls "$VAULT_PATH/wiki/sources/" 2>/dev/null || true)

run_claude "ingest .raw/sample.md"

# Find the new source-page file created by ingest. Skip `_index*` files —
# the ingest skill may emit a sources/_index.md alongside the page, and we
# want to assert against the actual content page, not the directory index.
SOURCES_AFTER=$(ls "$VAULT_PATH/wiki/sources/" 2>/dev/null || true)
NEW_SOURCES=$(comm -13 \
  <(echo "$SOURCES_BEFORE" | sort) \
  <(echo "$SOURCES_AFTER" | sort) | grep -v '^_index' || true)

if [ -n "$NEW_SOURCES" ]; then
  SOURCES_FILE="$VAULT_PATH/wiki/sources/$(echo "$NEW_SOURCES" | head -1)"
  bash /e2e/assertions/frontmatter.sh "$SOURCES_FILE"
else
  echo "  [FAIL] no new content page found in wiki/sources/ after ingest" >&2
  exit 1
fi

# ── Steps 8c–8e: /daily ×3 → daily-shape assertion (AC6) ─────────────────────
echo ""
echo "entrypoint-local: step 8c — /agents-memo:daily first entry"
run_claude "/agents-memo:daily E2E harness test entry one"
echo "entrypoint-local: step 8d — /agents-memo:daily second entry"
run_claude "/agents-memo:daily E2E harness test entry two"
echo "entrypoint-local: step 8e — /agents-memo:daily third entry"
run_claude "/agents-memo:daily E2E harness test entry three"
bash /e2e/assertions/daily-shape.sh "$VAULT_PATH"

# ── Step 8f: /daily-close → section-header assertion (AC7) ───────────────────
echo ""
echo "entrypoint-local: step 8f — /agents-memo:daily-close"
run_claude "/agents-memo:daily-close"
DAILY_FILE="$VAULT_PATH/daily/$(date +%F).md"
bash /e2e/assertions/section-header.sh "$DAILY_FILE" "## Summary"

# ── Step 9: All-pass summary (AC8) ───────────────────────────────────────────
echo ""
echo "=== entrypoint-local: all assertions passed — exit 0 ==="
