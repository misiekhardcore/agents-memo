#!/usr/bin/env bash
# Install (or remove) the weekly wiki-lint systemd USER timer.
#
# Writes two user unit files to ~/.config/systemd/user/:
#   agents-memo-wiki-lint.service — Type=oneshot, runs bin/wiki-lint-cron.sh
#   agents-memo-wiki-lint.timer   — OnCalendar (default weekly Sun 03:00),
#                                   Persistent=true (catches missed runs)
# then `systemctl --user daemon-reload` + `enable --now` the timer.
# Idempotent: re-running reports "already installed" and makes no changes.
# Used by the /memo:init command and available standalone.
#
# The unit PATH includes the pi binary dir — systemd user services do not
# inherit the shell PATH. HOME=%h is set explicitly for vault resolution.
#
# Usage:
#   bin/install-lint-service.sh                                # weekly, Sun 03:00
#   bin/install-lint-service.sh --schedule "Mon *-*-* 02:00:00" # custom OnCalendar
#   bin/install-lint-service.sh --uninstall                    # stop+disable+remove
#   bin/install-lint-service.sh --dry-run                      # show units, no changes

set -euo pipefail

INSTALL=1
UNINSTALL=0
DRY_RUN=0
SCHEDULE="Sun *-*-* 03:00:00"

args=("$@")
i=0
while [ $i -lt ${#args[@]} ]; do
  arg="${args[$i]}"
  case "$arg" in
    --uninstall) INSTALL=0 UNINSTALL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --schedule)
      i=$((i + 1))
      [ $i -ge ${#args[@]} ] && {
        echo "error: --schedule requires an OnCalendar value (e.g. \"Mon *-*-* 02:00:00\")" >&2
        exit 2
      }
      SCHEDULE="${args[$i]}"
      ;;
    --schedule=*) SCHEDULE="${arg#--schedule=}" ;;
    -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "error: unknown argument: $arg" >&2; exit 2 ;;
  esac
  i=$((i + 1))
done

# Locate the plugin root (same convention as other bin/ scripts).
if [ -z "${MEMO_PLUGIN_PWD:-}" ]; then
  SCRIPT_PATH=$(readlink -f "$0" 2>/dev/null || python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$0")
  MEMO_PLUGIN_PWD=$(dirname "$(dirname "$SCRIPT_PATH")")
  export MEMO_PLUGIN_PWD
fi

RUNNER="${MEMO_PLUGIN_PWD}/bin/wiki-lint-cron.sh"
UNIT_BASE="agents-memo-wiki-lint"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$UNIT_DIR/${UNIT_BASE}.service"
TIMER_FILE="$UNIT_DIR/${UNIT_BASE}.timer"

# The service PATH must include the pi binary dir (no shell PATH inheritance).
PI_PATH="$(command -v pi 2>/dev/null || true)"
if [ -z "$PI_PATH" ]; then
  echo "error: 'pi' not found on PATH — the lint service needs the pi CLI" >&2
  exit 1
fi
PI_DIR="$(dirname "$PI_PATH")"

if [ "$DRY_RUN" = "1" ]; then
  cat <<EOF
=== dry-run: would install systemd user timer ${UNIT_BASE}.timer
--- $SERVICE_FILE
[Unit]
Description=agents-memo wiki lint (memo-lint skill via pi -p)

[Service]
Type=oneshot
Environment=HOME=%h
Environment=PATH=$PI_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/bin/bash $RUNNER

--- $TIMER_FILE
[Unit]
Description=Weekly agents-memo wiki lint

[Timer]
OnCalendar=$SCHEDULE
Persistent=true

[Install]
WantedBy=timers.target

=== then: systemctl --user daemon-reload && systemctl --user enable --now ${UNIT_BASE}.timer
EOF
  exit 0
fi

if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "error: systemctl --user unavailable — is a systemd user session running?" >&2
  exit 1
fi

if [ "$UNINSTALL" = "1" ]; then
  if [ ! -f "$SERVICE_FILE" ] && [ ! -f "$TIMER_FILE" ]; then
    echo "[install-lint-service] no ${UNIT_BASE}.timer units found — nothing to remove"
    exit 0
  fi
  systemctl --user stop "${UNIT_BASE}.timer" 2>/dev/null || true
  systemctl --user disable "${UNIT_BASE}.timer" 2>/dev/null || true
  rm -f "$SERVICE_FILE" "$TIMER_FILE"
  systemctl --user daemon-reload
  echo "[install-lint-service] removed ${UNIT_BASE}.timer (service + timer units)"
  exit 0
fi

if systemctl --user is-enabled "${UNIT_BASE}.timer" >/dev/null 2>&1; then
  echo "[install-lint-service] already installed — no change (${UNIT_BASE}.timer enabled)"
  exit 0
fi

mkdir -p "$UNIT_DIR"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=agents-memo wiki lint (memo-lint skill via pi -p)

[Service]
Type=oneshot
Environment=HOME=%h
Environment=PATH=$PI_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/bin/bash $RUNNER
EOF

cat > "$TIMER_FILE" <<EOF
[Unit]
Description=Weekly agents-memo wiki lint

[Timer]
OnCalendar=$SCHEDULE
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "${UNIT_BASE}.timer"
echo "[install-lint-service] installed: ${UNIT_BASE}.timer (OnCalendar=$SCHEDULE, Persistent=true)"
echo "  logs: journalctl --user -u ${UNIT_BASE}.service"
