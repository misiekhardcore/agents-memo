#!/usr/bin/env bash
# Resolve a plugin config value in priority order:
#   0a. ~/.pi/agent/settings.json  (agentsMemo.<key>)
#   0b. .pi/settings.json          (merged, agentsMemo.<key>)
#   1. ~/.claude/settings.local.json  (pluginConfigs[*agents-memo*].options.<key>)
#   2. ~/.claude/settings.json        (same key, userSettings scope)
#   3. $2 default (if provided)
# Usage: resolve-config.sh <key> [default]
KEY="${1:-}"
DEFAULT="${2:-}"

if [ -z "$KEY" ]; then
  echo "resolve-config.sh: key argument required" >&2
  exit 1
fi

read_config_from_pi_settings() {
  local file="$1"
  [ -f "$file" ] || return 0
  # pi settings use camelCase keys (agentsMemo.bootstrapReadHot); callers pass
  # snake_case (bootstrap_read_hot). Normalize before lookup.
  local pi_key
  pi_key=$(printf '%s' "$KEY" | awk -F_ '{ printf "%s", $1; for (i=2; i<=NF; i++) printf "%s", toupper(substr($i,1,1)) substr($i,2) }')
  if command -v jq >/dev/null 2>&1; then
    # `select(. != null) | tostring` keeps boolean false/0 resolvable (jq's
    # `// empty` treats false as empty and would silently fall to the default).
    # projectMemory.enabled is the only nested key: the flat camelCase transform
    # yields a key that doesn't exist, so it gets a literal nested path.
    if [ "$KEY" = "project_memory_enabled" ]; then
      jq -r '.agentsMemo.projectMemory.enabled | select(. != null) | tostring' "$file" 2>/dev/null | head -1
    else
      jq -r --arg key "$pi_key" '.agentsMemo[$key] | select(. != null) | tostring' "$file" 2>/dev/null | head -1
    fi
  elif command -v python3 >/dev/null 2>&1; then
    SETTINGS_FILE="$file" CONFIG_KEY="$pi_key" python3 -c '
import json, os
try:
    with open(os.environ["SETTINGS_FILE"]) as f:
        d = json.load(f)
    block = d.get("agentsMemo", {})
    if os.environ["CONFIG_KEY"] == "projectMemoryEnabled":
        val = block.get("projectMemory", {}).get("enabled")
    else:
        val = block.get(os.environ["CONFIG_KEY"])
    if val is not None:
        print(str(val).lower())
except Exception:
    pass
' 2>/dev/null
  fi
}

read_config_from_settings() {
  local file="$1"
  [ -f "$file" ] || return 0
  if command -v jq >/dev/null 2>&1; then
    # Same `select(. != null) | tostring` treatment as the pi tier: boolean
    # false must resolve instead of falling through `// empty`.
    jq -r --arg key "$KEY" '(.pluginConfigs // {}) | to_entries[] | select(.key | contains("agents-memo")) | .value.options[$key] | select(. != null) | tostring' "$file" 2>/dev/null | head -1
  elif command -v python3 >/dev/null 2>&1; then
    SETTINGS_FILE="$file" CONFIG_KEY="$KEY" python3 -c '
import json, os
try:
    with open(os.environ["SETTINGS_FILE"]) as f:
        d = json.load(f)
    key = os.environ["CONFIG_KEY"]
    for k, v in d.get("pluginConfigs", {}).items():
        if "agents-memo" in k:
            val = v.get("options", {}).get(key)
            if val is not None:
                print(str(val).lower())
                break
            # key absent/unset in this entry — keep scanning later entries
            # (jq to_entries[] ... | head -1 takes the first resolvable)
except Exception:
    pass
' 2>/dev/null
  fi
}

VALUE=""
# Priority tier 0: pi settings
for pi_settings in "$HOME/.pi/agent/settings.json" "$(pwd)/.pi/settings.json"; do
  [ -n "$VALUE" ] && break
  VALUE=$(read_config_from_pi_settings "$pi_settings")
done

for settings_file in "$HOME/.claude/settings.local.json" "$HOME/.claude/settings.json"; do
  [ -n "$VALUE" ] && break
  VALUE=$(read_config_from_settings "$settings_file")
done

if [ -z "$VALUE" ]; then
  echo "${DEFAULT}"
else
  echo "$VALUE"
fi
