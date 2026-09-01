#!/usr/bin/env bash
# agents-memo vault setup script
# Run this ONCE before opening Obsidian for the first time.
# Usage: bin/setup-vault.sh /path/to/vault

set -euo pipefail

if [ -z "${1:-}" ] || [ -z "$1" ]; then
  echo "Error: vault path is required"
  echo ""
  echo "Usage: bin/setup-vault.sh /absolute/path/to/vault"
  echo ""
  echo "Example:"
  echo "  bin/setup-vault.sh /home/user/my-vault"
  echo "  bin/setup-vault.sh /tmp/test-vault"
  exit 1
fi

VAULT="$1"
OBSIDIAN="$VAULT/.obsidian"

# Locate the plugin root. Prefer MEMO_PLUGIN_PWD when set (in-session).
# Otherwise derive it from $0 so standalone invocations work.
if [ -z "${MEMO_PLUGIN_PWD:-}" ]; then
  SCRIPT_PATH=$(readlink -f "$0" 2>/dev/null || python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$0")
  MEMO_PLUGIN_PWD=$(dirname "$(dirname "$SCRIPT_PATH")")
  export MEMO_PLUGIN_PWD
fi

DEFAULTS_DIR="${MEMO_PLUGIN_PWD}/_obsidian-defaults"

echo "Setting up agents-memo vault at: $VAULT"

# ── 1. Create directories ─────────────────────────────────────────────────────
mkdir -p "$OBSIDIAN/snippets"
mkdir -p "$VAULT/.raw"
mkdir -p "$VAULT/wiki/concepts" "$VAULT/wiki/entities" "$VAULT/wiki/sources" "$VAULT/wiki/questions" "$VAULT/wiki/meta"
mkdir -p "$VAULT/_templates"

# ── 2. Copy Obsidian default configs (graph.json, app.json, appearance.json) ──
# Copied only on FIRST setup (no existing app.json) so re-running init on an
# existing vault never clobbers user-customized Obsidian config. Force a
# re-sync with AGENTS_MEMO_SYNC_OBSIDIAN=1.
if [ ! -d "$DEFAULTS_DIR" ]; then
  echo "Error: defaults directory not found at $DEFAULTS_DIR" >&2
  exit 1
fi
if [ ! -f "$OBSIDIAN/app.json" ] || [ "${AGENTS_MEMO_SYNC_OBSIDIAN:-0}" = "1" ]; then
  for src in "$DEFAULTS_DIR"/*.json; do
    [ -e "$src" ] || continue
    cp "$src" "$OBSIDIAN/$(basename "$src")"
  done
else
  echo "Skipping Obsidian config copy (existing config found — set AGENTS_MEMO_SYNC_OBSIDIAN=1 to force)"
fi

# ── 5. Download Excalidraw main.js (8MB, not in git) ─────────────────────────
EXCALIDRAW="$OBSIDIAN/plugins/obsidian-excalidraw-plugin"
if [ -f "$EXCALIDRAW/manifest.json" ] && [ ! -f "$EXCALIDRAW/main.js" ]; then
  echo "Downloading Excalidraw main.js (~8MB)..."
  curl -sS -L \
    "https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/latest/download/main.js" \
    -o "$EXCALIDRAW/main.js"
  echo "✓ Excalidraw main.js downloaded"
elif [ -f "$EXCALIDRAW/main.js" ]; then
  echo "✓ Excalidraw main.js already present"
fi

echo "✓ Obsidian config installed."
