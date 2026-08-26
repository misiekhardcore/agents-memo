#!/usr/bin/env bash
# Install (or remove) the weekly wiki-lint cron entry.
#
# Adds `0 3 * * 0 <this-script-dir>/wiki-lint-cron.sh` to the user crontab,
# preserving all existing entries. Idempotent: re-running reports "already
# installed" and makes no changes. Used by the /memo:init command and
# available standalone.
#
# Usage:
#   bin/install-lint-cron.sh                  # install (default weekly, Sun 03:00)
#   bin/install-lint-cron.sh --schedule "0 2 * * 1"   # custom schedule
#   bin/install-lint-cron.sh --uninstall      # remove the entry
#   bin/install-lint-cron.sh --dry-run        # show what would change, change nothing

set -euo pipefail

INSTALL=1
UNINSTALL=0
DRY_RUN=0
SCHEDULE="0 3 * * 0"

args=("$@")
i=0
while [ $i -lt ${#args[@]} ]; do
  arg="${args[$i]}"
  case "$arg" in
    --uninstall) INSTALL=0 UNINSTALL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --schedule)
      i=$((i + 1))
      [ $i -ge ${#args[@]} ] && { echo "error: --schedule requires a value (e.g. --schedule \"0 2 * * 1\")" >&2; exit 2; }
      SCHEDULE="${args[$i]}"
      ;;
    --schedule=*) SCHEDULE="${arg#--schedule=}" ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "error: unknown argument: $arg" >&2; exit 2 ;;
  esac
  i=$((i + 1))
done

# Locate the plugin root (same convention as the other bin/ scripts).
if [ -z "${MEMO_PLUGIN_PWD:-}" ]; then
  SCRIPT_PATH=$(readlink -f "$0" 2>/dev/null || python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$0")
  MEMO_PLUGIN_PWD=$(dirname "$(dirname "$SCRIPT_PATH")")
  export MEMO_PLUGIN_PWD
fi

CRON_CMD="${MEMO_PLUGIN_PWD}/bin/wiki-lint-cron.sh"
ENTRY="${SCHEDULE} ${CRON_CMD}"

cron_read() {
  crontab -l 2>/dev/null || true
}

cron_write() {
  crontab - 2>/dev/null || true
}

EXISTING=$(cron_read)

if [ "$UNINSTALL" = "1" ]; then
  FILTERED=$(printf '%s\n' "$EXISTING" | grep -vF "$CRON_CMD" || true)
  if [ "$EXISTING" = "$FILTERED" ]; then
    echo "[install-lint-cron] no lint cron entry found — nothing to remove"
    exit 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "[install-lint-cron] (dry-run) would remove:"
    printf '%s\n' "$EXISTING" | grep -F "$CRON_CMD"
    exit 0
  fi
  printf '%s\n' "$FILTERED" | cron_write
  echo "[install-lint-cron] removed lint cron entry ($CRON_CMD)"
  exit 0
fi

if printf '%s\n' "$EXISTING" | grep -qF "$CRON_CMD"; then
  echo "[install-lint-cron] already installed — no change"
  printf '%s\n' "$EXISTING" | grep -F "$CRON_CMD"
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "[install-lint-cron] (dry-run) would add:"
  echo "  $ENTRY"
  exit 0
fi

{
  printf '%s\n' "$EXISTING"
  [ -n "$EXISTING" ] && [ -n "$(printf '%s\n' "$EXISTING" | tail -1)" ] && echo
  echo "$ENTRY"
} | cron_write

echo "[install-lint-cron] installed: $ENTRY"
echo "Note: the cron job runs the memo-lint skill via pi -p; it requires"
echo "Obsidian to be running and the agents-memo package registered in pi."
