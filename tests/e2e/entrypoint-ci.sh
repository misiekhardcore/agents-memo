#!/usr/bin/env bash
# CI fast-tier entrypoint. Boots Obsidian under Xvfb against a freshly
# scaffolded vault, then runs `tests/cli-smoke.sh` and exits with its code.
# No auth, no `claude -p` calls (AC11). Sequence per #89 Section D.
#
# The container is always `--rm` (per harness policy); cleanup of /tmp/vault
# and child processes is best-effort and only matters when running the image
# locally for debugging.

set -euo pipefail

PLUGIN_SRC="${PLUGIN_SRC:-/opt/plugin-src}"
VAULT_PATH="${VAULT_PATH:-/tmp/vault}"
DISPLAY_NUM="${DISPLAY_NUM:-:99}"

# 1. Verify mount.
if [ ! -d "$PLUGIN_SRC" ]; then
  echo "entrypoint-ci: plugin source not mounted at $PLUGIN_SRC" >&2
  exit 2
fi
if [ ! -r "$PLUGIN_SRC/bin/setup-vault.sh" ]; then
  echo "entrypoint-ci: $PLUGIN_SRC/bin/setup-vault.sh missing or not readable" >&2
  exit 2
fi

# 2. Scaffold vault.
echo "entrypoint-ci: scaffolding vault at $VAULT_PATH"
rm -rf "$VAULT_PATH"
mkdir -p "$VAULT_PATH"
MEMO_PLUGIN_PWD="$PLUGIN_SRC" bash "$PLUGIN_SRC/bin/setup-vault.sh" "$VAULT_PATH"

# 3. Point the wrapper's vault resolution at the scaffolded vault. The pi
# settings tier (~/.pi/agent/settings.json, agentsMemo.vaultPath) is the
# extension's documented config path; scripts/resolve-vault.sh reads it as
# tier 0a. The former Claude Code plugin wiring that supplied the vault path
# via ~/.claude/settings.json was removed with the local e2e tier.
mkdir -p "$HOME/.pi/agent"
# Emit via jq so VAULT_PATH is JSON-escaped (jq ships in the CI image).
jq -n --arg v "$VAULT_PATH" '{agentsMemo: {vaultPath: $v}}' > "$HOME/.pi/agent/settings.json"

# 4. Seed the two files cli-smoke.sh assumes exist (`wiki/hot.md` for the
# read+probe assertions, `wiki/index.md` for the backlinks assertion).
# Per #89 Decision: skip seed-demo.sh; supply only what the smoke needs.
# hot.md links to index.md so the backlinks query returns a non-empty result —
# Obsidian's CLI emits the literal "No backlinks found." text when there are
# zero backlinks even with format=json, which would fail the smoke's JSON
# shape assertion.
if [ ! -f "$VAULT_PATH/wiki/hot.md" ]; then
  cat > "$VAULT_PATH/wiki/hot.md" <<'EOF'
# Hot cache

See [[index]] for the wiki entrypoint.
EOF
fi
[ -f "$VAULT_PATH/wiki/index.md" ] || echo "# Wiki index" > "$VAULT_PATH/wiki/index.md"

# 5. Register vault with Obsidian (writes ~/.config/obsidian/obsidian.json).
bash /e2e/register-vault.sh "$VAULT_PATH"

# 6. Boot Xvfb + D-Bus + Obsidian.
echo "entrypoint-ci: starting Xvfb on $DISPLAY_NUM"
Xvfb "$DISPLAY_NUM" -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
export DISPLAY="$DISPLAY_NUM"
sleep 1

echo "entrypoint-ci: starting D-Bus session"
# `dbus-launch --sh-syntax` prints DBUS_SESSION_BUS_ADDRESS and PID assignments.
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID

echo "entrypoint-ci: launching Obsidian GUI"
# `obsidian` on $PATH is the CLI binary (per cli-setup.md). The GUI Electron
# app is /opt/Obsidian/AppRun. APPDIR must be set explicitly — AppRun's
# auto-detection walks up looking for a dir containing $1, which fails when
# $1 starts with `--`.
#
# Flag rationale:
#   --no-sandbox            Containers don't grant user-namespace caps the
#                           Chromium sandbox needs. SUID-helper path also
#                           fails as root inside a container.
#   --disable-gpu           No accelerated GL inside the container.
#   --disable-dev-shm-usage Default /dev/shm in Docker is 64MB which crashes
#                           Chromium under load; falls back to /tmp.
launch_obsidian() {
  APPDIR=/opt/Obsidian /opt/Obsidian/AppRun \
      --no-sandbox \
      --disable-gpu \
      --disable-dev-shm-usage \
      >>/tmp/obsidian.log 2>&1 &
  OBSIDIAN_PID=$!
}

launch_obsidian
# Defensive retry: rare Chromium SIGTRAP during Electron init has been
# observed on the very first launch after a fresh image build. If the
# process dies in the first 3s, give it one more shot before we let the
# 60s readiness probe deal with it.
sleep 3
if ! kill -0 "$OBSIDIAN_PID" 2>/dev/null; then
  echo "entrypoint-ci: Obsidian process died during init; relaunching once"
  launch_obsidian
fi

cleanup() {
  local rc=$?
  kill "$OBSIDIAN_PID"          2>/dev/null || true
  kill "$XVFB_PID"              2>/dev/null || true
  if [ -n "${DBUS_SESSION_BUS_PID:-}" ]; then
    kill "$DBUS_SESSION_BUS_PID" 2>/dev/null || true
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

# 7. Probe readiness (60s cap per AC13).
if ! bash /e2e/wait-for-obsidian.sh; then
  echo "entrypoint-ci: readiness probe failed; tail of Obsidian log:" >&2
  tail -100 /tmp/obsidian.log >&2 || true
  exit 1
fi

# 8. Run cli-smoke.sh and inherit its exit code (AC10).
echo "entrypoint-ci: running tests/cli-smoke.sh"
SMOKE_RC=0
bash "$PLUGIN_SRC/tests/cli-smoke.sh" || SMOKE_RC=$?

echo "entrypoint-ci: cli-smoke.sh exited with $SMOKE_RC"
exit "$SMOKE_RC"
