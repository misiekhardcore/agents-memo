#!/usr/bin/env bash
# Seed a vault with starter stub files and one example per page type.
# Walks `${MEMO_PLUGIN_PWD}/_seed/` and copies each file to the vault,
# skipping any file that already exists (idempotent). The `{{today}}`
# placeholder is substituted with the current date during copy.
#
# Usage: bin/seed-demo.sh /absolute/path/to/vault

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

SEED_DIR="${MEMO_PLUGIN_PWD}/_seed"
TODAY=$(date +%Y-%m-%d)

if [ ! -d "$SEED_DIR" ]; then
  echo "Error: seed directory not found at $SEED_DIR" >&2
  exit 1
fi

# Walk the seed tree and copy each file into the vault, preserving the
# relative path. Skip files that already exist. Substitute {{today}}.
while IFS= read -r -d '' src; do
  rel="${src#$SEED_DIR/}"
  dst="$VAULT/$rel"
  [ -e "$dst" ] && continue
  mkdir -p "$(dirname "$dst")"
  sed "s/{{today}}/$TODAY/g" "$src" > "$dst"
done < <(find "$SEED_DIR" -type f -print0)

echo "✓ Demo vault seeded at: $VAULT"
