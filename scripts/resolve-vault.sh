#!/usr/bin/env bash
# Resolve the vault path in priority order:
#   0a. ~/.pi/agent/settings.json  (agentsMemo.vaultPath)
#   0b. .pi/settings.json          (merged, agentsMemo.vaultPath)
#   1. $1 argument (legacy; no longer passed by hooks as of #36)
#   2. $(pwd) if it contains a wiki/ subdirectory
#   3. ~/.claude/settings.local.json  (pluginConfigs[*agents-memo*].options.vault_path)
#   4. ~/.claude/settings.json        (same key, userSettings scope written by /plugin manage)

# Normalize a leading ~ in any resolved path (pi settings store "~/..." literally).
expand_tilde() {
  local p="$1"
  case "$p" in
    "~"|\~/*) p="${HOME}${p#"~"}" ;;
  esac
  printf '%s' "$p"
}

read_vault_from_pi_settings() {
  local file="$1"
  [ -f "$file" ] || return 0
  if command -v jq >/dev/null 2>&1; then
    jq -r '.agentsMemo.vaultPath // empty' "$file" 2>/dev/null | head -1
  elif command -v python3 >/dev/null 2>&1; then
    SETTINGS_FILE="$file" python3 -c '
import json, os
try:
    with open(os.environ["SETTINGS_FILE"]) as f:
        d = json.load(f)
    val = d.get("agentsMemo", {}).get("vaultPath", "")
    if val:
        print(val)
except Exception:
    pass
' 2>/dev/null
  fi
}

read_vault_from_settings() {
  local file="$1"
  [ -f "$file" ] || return 0
  if command -v jq >/dev/null 2>&1; then
    jq -r '(.pluginConfigs // {}) | to_entries[] | select(.key | contains("agents-memo")) | .value.options.vault_path // empty' "$file" 2>/dev/null | head -1
  elif command -v python3 >/dev/null 2>&1; then
    SETTINGS_FILE="$file" python3 -c '
import json, os
try:
    with open(os.environ["SETTINGS_FILE"]) as f:
        d = json.load(f)
    for k, v in d.get("pluginConfigs", {}).items():
        if "agents-memo" in k:
            print(v.get("options", {}).get("vault_path", ""))
            break
except Exception:
    pass
' 2>/dev/null
  fi
}

VAULT=""

# Priority tier 0: pi settings (both global and merged project files)
for pi_settings in "$HOME/.pi/agent/settings.json" "$(pwd)/.pi/settings.json"; do
  [ -n "$VAULT" ] && break
  VAULT=$(read_vault_from_pi_settings "$pi_settings")
done

# Extension parity: a configured vaultPath that is missing or not a directory
# must not win over lower tiers (the extension's resolveVaultPath() checks
# exists + isDirectory before accepting the configured path). Expand the
# tilde first so the check sees the real absolute path.
if [ -n "$VAULT" ]; then
  VAULT=$(expand_tilde "$VAULT")
  [ -d "$VAULT" ] || VAULT=""
fi

# Tier 1: explicit argument (legacy; no longer passed by hooks as of #36)
[ -z "$VAULT" ] && VAULT="${1:-}"

# Tier 2: pwd if it contains a wiki/ subdirectory
[ -z "$VAULT" ] && [ -d "$(pwd)/wiki" ] && VAULT="$(pwd)"

# Tier 3/4: Claude Code settings. Same existence gate as tier 0 (a stale
# vault_path must not win over nothing — parity with the extension's
# resolveVaultPath()).
for settings_file in "$HOME/.claude/settings.local.json" "$HOME/.claude/settings.json"; do
  [ -n "$VAULT" ] && break
  VAULT=$(read_vault_from_settings "$settings_file")
  [ -n "$VAULT" ] && {
    VAULT=$(expand_tilde "$VAULT")
    [ -d "$VAULT" ] || VAULT=""
  }
done

VAULT=$(expand_tilde "$VAULT")

if [ -z "$VAULT" ]; then
  echo "agents-memo: no vault configured — run /wiki init to set up" >&2
  exit 1
fi
echo "$VAULT"
