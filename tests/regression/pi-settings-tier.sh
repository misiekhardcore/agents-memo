#!/usr/bin/env bash
# Regression: pi settings tier (0a/0b) in resolve-vault.sh / resolve-config.sh.
#
# Covers: tilde expansion of agentsMemo.vaultPath, global-vs-project per-key
# first-wins ordering, and snake_case → camelCase key normalization for the
# pi settings lookup. Hermetic: scratch HOME + scratch vault, no Obsidian, no
# Claude Code settings.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESOLVE_VAULT="$ROOT/scripts/resolve-vault.sh"
RESOLVE_CONFIG="$ROOT/scripts/resolve-config.sh"

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
export HOME="$SCRATCH/home"
mkdir -p "$HOME/.pi/agent" "$HOME/.claude" "$SCRATCH/vault"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "[ok] $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "[FAIL] $1"; }
check() { # check <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — expected '$2', got '$3'"; fi
}

cd "$SCRATCH" # no wiki/ here — isolate CWD discovery

# 1. Global pi settings: tilde-expanded vaultPath (tier 0a).
write_global() { printf '%s\n' "$1" > "$HOME/.pi/agent/settings.json"; }
write_project() { mkdir -p "$SCRATCH/.pi"; printf '%s\n' "$1" > "$SCRATCH/.pi/settings.json"; }

write_global '{"agentsMemo": { "vaultPath": "~/vault" }}'
mkdir -p "$HOME/vault"
check "tilde in agentsMemo.vaultPath expanded" "$HOME/vault" "$(bash "$RESOLVE_VAULT")"

# 2. Global wins over project per-key (both define vaultPath).
write_global '{"agentsMemo": { "vaultPath": "~/global-vault" }}'
mkdir -p "$HOME/global-vault"
write_project '{"agentsMemo": { "vaultPath": "/project-vault" }}'
check "global vaultPath wins over project" "$HOME/global-vault" "$(bash "$RESOLVE_VAULT")"

# 3. Project fills keys the global block leaves undefined.
write_global '{"agentsMemo": { "autoCommit": false }}'
write_project '{"agentsMemo": { "vaultPath": "~/project-vault" }}'
mkdir -p "$HOME/project-vault"
check "project vaultPath used when global has no vaultPath" "$HOME/project-vault" "$(bash "$RESOLVE_VAULT")"

# 4. resolve-config: camelCase key in pi settings resolves snake_case lookup.
write_global '{"agentsMemo": { "bootstrapReadHot": "always" }}'
write_project '{"agentsMemo": { "bootstrapReadHot": "never" }}'
check "camelCase pi key resolves snake_case lookup (global wins)" \
  "always" "$(bash "$RESOLVE_CONFIG" bootstrap_read_hot)"

write_global '{"agentsMemo": { "autoCommit": false }}'
write_project '{"agentsMemo": { "bootstrapReadHot": "on-demand" }}'
check "camelCase pi key resolved from project tier" \
  "on-demand" "$(bash "$RESOLVE_CONFIG" bootstrap_read_hot)"
check "boolean false resolves (not treated as empty)" \
  "false" "$(bash "$RESOLVE_CONFIG" auto_commit)"

# 5. No pi settings → falls back to the default argument.
rm -f "$HOME/.pi/agent/settings.json" "$SCRATCH/.pi/settings.json"
check "default fallback when no pi settings" \
  "on-demand" "$(bash "$RESOLVE_CONFIG" bootstrap_read_hot on-demand)"

# 6. Stale vaultPath (does not exist as a directory) → falls through to the
# CWD wiki tier, mirroring the extension's resolveVaultPath() existence check.
write_global '{"agentsMemo": { "vaultPath": "~/does-not-exist" }}'
rm -f "$SCRATCH/.pi/settings.json"
mkdir -p "$SCRATCH/wiki"
check "stale vaultPath falls through to CWD wiki tier" "$SCRATCH" "$(bash "$RESOLVE_VAULT")"
rm -rf "$SCRATCH/wiki"

# 7. Stale vaultPath with no lower tier → resolution error (exit 1).
write_global '{"agentsMemo": { "vaultPath": "~/still-missing" }}'
if bash "$RESOLVE_VAULT" >/dev/null 2>&1; then
  bad "stale vaultPath with no fallback → should exit 1"
else
  ok "stale vaultPath with no fallback → exit 1"
fi

# 8. Claude Code settings tier (3/4): vault_path resolves when no pi settings
#    and no CWD wiki, with tilde expansion.
rm -f "$HOME/.pi/agent/settings.json" "$SCRATCH/.pi/settings.json"
rm -rf "$SCRATCH/wiki"
mkdir -p "$HOME/.claude" "$HOME/claude-vault"
printf '%s\n' '{"pluginConfigs": {"claude-code-agents-memo": {"options": {"vault_path": "~/claude-vault"}}}}' > "$HOME/.claude/settings.json"
check "claude settings vault_path resolves (tilde expanded)" "$HOME/claude-vault" "$(bash "$RESOLVE_VAULT")"

# 9. Stale claude vault_path (not a directory) → existence gate → exit 1.
printf '%s\n' '{"pluginConfigs": {"claude-code-agents-memo": {"options": {"vault_path": "~/stale-claude-vault"}}}}' > "$HOME/.claude/settings.json"
if bash "$RESOLVE_VAULT" >/dev/null 2>&1; then
  bad "stale claude vault_path with no fallback → should exit 1"
else
  ok "stale claude vault_path with no fallback → exit 1"
fi

# 10. Claude-tier boolean keys resolve (parity with the pi-tier fix): a
#     boolean false in pluginConfigs options must not fall through to the
#     default.
printf '%s\n' '{"pluginConfigs": {"claude-code-agents-memo": {"options": {"auto_commit": false}}}}' > "$HOME/.claude/settings.json"
check "claude-tier boolean false resolves" "false" "$(bash "$RESOLVE_CONFIG" auto_commit)"
rm -f "$HOME/.claude/settings.json"
check "claude-tier missing key falls to default" "on-demand" "$(bash "$RESOLVE_CONFIG" bootstrap_read_hot on-demand)"

# 11. Nested projectMemory.enabled resolves from the global tier (the flat
#     camelCase transform alone cannot reach a nested key).
write_global '{"agentsMemo": { "projectMemory": { "enabled": true } }}'
check "nested projectMemory.enabled resolves (global tier)" "true" "$(bash "$RESOLVE_CONFIG" project_memory_enabled)"

# 12. Project tier fills the nested key the global block leaves undefined;
#     boolean false must resolve (not fall to the default).
write_global '{"agentsMemo": { "vaultPath": "~/vault" }}'
mkdir -p "$HOME/vault"
write_project '{"agentsMemo": { "projectMemory": { "enabled": false } }}'
check "nested projectMemory.enabled from project tier (false resolves)" "false" "$(bash "$RESOLVE_CONFIG" project_memory_enabled)"

# 13. No pi settings → project_memory_enabled falls to the default argument.
rm -f "$HOME/.pi/agent/settings.json" "$SCRATCH/.pi/settings.json"
check "project_memory_enabled default fallback" "true" "$(bash "$RESOLVE_CONFIG" project_memory_enabled true)"
# 14. PI_CODING_AGENT_DIR override wins over $HOME/.pi/agent/settings.json
#     (config-dir redirection must propagate to vault + key resolution).
rm -f "$HOME/.pi/agent/settings.json" "$SCRATCH/.pi/settings.json"
rm -rf "$SCRATCH/wiki"
write_global '{"agentsMemo": { "vaultPath": "~/home-vault" }}'
mkdir -p "$HOME/home-vault" "$SCRATCH/override-agent" "$SCRATCH/override-vault"
printf '{"agentsMemo": { "vaultPath": "%s", "autoCommit": false }}' "$SCRATCH/override-vault" > "$SCRATCH/override-agent/settings.json"
export PI_CODING_AGENT_DIR="$SCRATCH/override-agent"
check "PI_CODING_AGENT_DIR vaultPath wins over HOME tier" "$SCRATCH/override-vault" "$(bash "$RESOLVE_VAULT")"
check "PI_CODING_AGENT_DIR key resolution" "false" "$(bash "$RESOLVE_CONFIG" auto_commit)"

# 15. Override replaces the config dir: without vaultPath it falls through to
#     lower tiers and does NOT consult the $HOME tier.
mkdir -p "$SCRATCH/wiki"
printf '%s\n' '{}' > "$SCRATCH/override-agent/settings.json"
check "override dir without vaultPath falls to CWD wiki (HOME tier not consulted)" "$SCRATCH" "$(bash "$RESOLVE_VAULT")"
unset PI_CODING_AGENT_DIR
rm -rf "$SCRATCH/wiki" "$SCRATCH/override-agent" "$HOME/home-vault"

rm -f "$HOME/.pi/agent/settings.json"

echo
echo "=== summary ==="
echo "  pass=$PASS  fail=$FAIL"
[ "$FAIL" -eq 0 ]
