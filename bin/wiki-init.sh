#!/usr/bin/env bash
# Umbrella script for `/memo-wiki init`. Seeds an Obsidian vault from the path
# passed in $1 by delegating to setup-vault.sh + copy-templates.sh, then
# prints next steps. Re-running is idempotent.
#
# Usage: bin/wiki-init.sh /absolute/path/to/vault
#
# If $1 is empty, prints the configured "vault not set" message and exits 0
# (no error) so `/memo-wiki init` can guide the user to set vault_path without
# aborting the session.

set -euo pipefail

VAULT="${1:-}"

if [ -z "$VAULT" ]; then
  echo "Configure vault path first: enable the plugin and enter your vault path when prompted"
  exit 0
fi

# Locate the plugin root. Prefer MEMO_PLUGIN_PWD when set (in-session).
# Otherwise derive it from $0 so standalone invocations work.
if [ -z "${MEMO_PLUGIN_PWD:-}" ]; then
  SCRIPT_PATH=$(readlink -f "$0" 2>/dev/null || python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$0")
  MEMO_PLUGIN_PWD=$(dirname "$(dirname "$SCRIPT_PATH")")
  export MEMO_PLUGIN_PWD
fi

bash "${MEMO_PLUGIN_PWD}/bin/setup-vault.sh" "$VAULT"
bash "${MEMO_PLUGIN_PWD}/bin/copy-templates.sh" "$VAULT"
bash "${MEMO_PLUGIN_PWD}/bin/seed-demo.sh" "$VAULT"

cat <<EOF

Next steps:
  1. Open $VAULT/FIRST_RUN.md for detailed setup instructions.
  2. Open Obsidian → Manage Vaults → Open folder as vault → select: $VAULT
  3. Enable the **Bases** core plugin (Settings → Core plugins).
  4. Enable community plugins when prompted, then install:
       - Templater
       - Tray  (keeps Obsidian alive when the window is closed)
  5. Run /memo-wiki in pi to route vault operations, or /memo:init to
     re-run initialization (git init, vault AGENTS.md, optional lint cron).
EOF
