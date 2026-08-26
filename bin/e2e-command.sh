#!/usr/bin/env bash
# Run a pi extension command end-to-end in a REAL pi instance, isolated from
# the user's real config.
#
# Why isolated HOME: the extension resolves the vault from tier 0a
# (~/.pi/agent/settings.json) BEFORE project settings — a headless run would
# hit the real vault. We copy the real settings into a scratch HOME, rewrite
# agentsMemo.vaultPath + relative package paths to absolute, and run
# `pi -p "/<command>"` from a scratch project dir.
#
# Headless dispatch: `pi -p` routes the prompt through session.prompt(), which
# executes registered extension commands ("/"-prefixed) without calling the
# model. Caveat: print mode has ctx.hasUI=false, so ui.input/confirm/notify
# branches are skipped — headless covers the core path; interactive branches
# are covered by tests/extension-smoke.mjs (mocked ui) or a TUI session.
#
# Usage:
#   bin/e2e-command.sh "<command>" [--vault /abs/path] [--no-vault] [--keep]
#     --vault PATH   set agentsMemo.vaultPath to PATH in the scratch HOME
#     --no-vault     remove agentsMemo.vaultPath (tests the unconfigured path)
#     --keep         keep the scratch dir (default: removed on exit)
#   Env: PI_BIN (default: pi), E2E_KEEP=1

set -euo pipefail

COMMAND=""
VAULT_MODE="keep"   # keep | set | unset
VAULT_PATH=""
KEEP=0
[ "${E2E_KEEP:-0}" = "1" ] && KEEP=1

while [ $# -gt 0 ]; do
  case "$1" in
    --vault)
      VAULT_MODE="set"
      VAULT_PATH="$2"
      shift 2
      ;;
    --no-vault)
      VAULT_MODE="unset"
      shift
      ;;
    --keep)
      KEEP=1
      shift
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      exit 2
      ;;
    *)
      [ -n "$COMMAND" ] && { echo "error: only one command expected" >&2; exit 2; }
      COMMAND="$1"
      shift
      ;;
  esac
done

[ -n "$COMMAND" ] || { echo "error: usage: $0 \"<command>\" [--vault PATH|--no-vault] [--keep]" >&2; exit 2; }
[ -f "$HOME/.pi/agent/settings.json" ] || { echo "error: no $HOME/.pi/agent/settings.json to copy" >&2; exit 2; }

PI_BIN="${PI_BIN:-pi}"
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

mkdir -p "$SCRATCH/home/.pi/agent" "$SCRATCH/project"

# Copy the real settings; rewrite vault path + make package paths absolute.
# Relative entries resolve against the settings path AS LOADED (lexically, no
# symlink following — ~/.pi/agent may be a symlink into pi-config, and pi
# resolves relative entries against the path it read, not the symlink target).
REAL_SETTINGS="$HOME/.pi/agent/settings.json"
cp "$REAL_SETTINGS" "$SCRATCH/home/.pi/agent/settings.json"
SETTINGS="$SCRATCH/home/.pi/agent/settings.json"

VAULT_MODE_JSON="null"
case "$VAULT_MODE" in
  set) VAULT_MODE_JSON="\"$VAULT_PATH\"" ;;
  unset) VAULT_MODE_JSON="\"__unset__\"" ;;
esac

python3 - "$SETTINGS" "$REAL_SETTINGS" "$VAULT_MODE" "$VAULT_PATH" <<'PY'
import json, os, sys

path, real_settings, mode, vault = sys.argv[1:5]
with open(path) as f:
    d = json.load(f)

if mode == "set":
    d.setdefault("agentsMemo", {})["vaultPath"] = vault
elif mode == "unset":
    d.get("agentsMemo", {}).pop("vaultPath", None)

base = os.path.dirname(real_settings)  # as loaded, may be a symlink path
home = os.path.expanduser("~")
out = []
for p in d.get("packages", []):
    if p.startswith("npm:") or p.startswith("/"):
        out.append(p)
    elif p.startswith("~/"):
        out.append(os.path.join(home, p[2:]))
    else:
        out.append(os.path.normpath(os.path.join(base, p)))
d["packages"] = out

with open(path, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
PY
if [ $? -ne 0 ]; then
  echo "error: settings rewrite failed" >&2
  exit 1
fi

echo "=== scratch HOME: $SCRATCH/home"
echo "=== agentsMemo.vaultPath: $(jq -r '.agentsMemo.vaultPath // "(unset)"' "$SETTINGS")"
echo "=== packages: $(jq -r '.packages | length' "$SETTINGS") entries (rewritten absolute)"

echo "=== running: pi -p \"/$COMMAND\" (cwd=$SCRATCH/project)"
set +e
(
  cd "$SCRATCH/project" || exit 1
  HOME="$SCRATCH/home" timeout 120 "$PI_BIN" -p "/$COMMAND" 2>&1 | tail -8
)
EXIT_CODE=${PIPESTATUS[0]}
set -e
echo "=== exit code: $EXIT_CODE"

if [ "$KEEP" = "1" ]; then
  echo "=== kept scratch: $SCRATCH (home/, project/)"
fi
exit "$EXIT_CODE"
