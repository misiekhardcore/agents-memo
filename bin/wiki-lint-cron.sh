#!/usr/bin/env bash
# Standalone wiki-lint runner intended for system cron.
#
# One-shot: invokes the lint skill via the `claude` CLI and stamps the lastrun
# marker on success. Exits non-zero on resolve-vault failure or when Obsidian
# is unreachable (so cron surfaces the error in mail/logs); lint-skill output
# flows through to stdout/stderr.
#
# Runs unattended: pre-authorizes the lint skill to auto-fix every category
# it classifies as 'safe to auto-fix' (missing frontmatter, stubs for missing
# entities, wikilinks for unlinked mentions). Categories that need human
# judgment (orphan deletion, contradiction resolution, duplicate merging)
# remain advisory and surface in the lint report only. Run `/lint` interactively
# to act on those.
#
# Requires Obsidian to be running — the CLI cannot reach a closed vault.
#
# Usage (example crontab — weekly, Sunday 03:00):
#   0 3 * * 0 /absolute/path/to/agents-memo/bin/wiki-lint-cron.sh

set -e

# Locate the plugin root. Prefer MEMO_PLUGIN_PWD when set (in-session).
# Otherwise derive it from $0 so cron invocations work without a session.
if [ -z "${MEMO_PLUGIN_PWD:-}" ]; then
  SCRIPT_PATH=$(readlink -f "$0" 2>/dev/null || python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$0")
  MEMO_PLUGIN_PWD=$(dirname "$(dirname "$SCRIPT_PATH")")
  export MEMO_PLUGIN_PWD
fi

VAULT=$("${MEMO_PLUGIN_PWD}/scripts/resolve-vault.sh") || exit 1

claude -p "Run the wiki-lint skill on $VAULT. This is an unattended scheduled run — do not ask for confirmation. Auto-fix every issue the skill classifies as 'safe to auto-fix'. Write the lint report and report briefly. Commit and push the changes as 'chore: lint vault <datetime>'" || {
  echo "[wiki-lint-cron] lint skill failed — is Obsidian running?" >&2
  exit 1
}

date +%s > "$VAULT/.wiki-lint.lastrun"
