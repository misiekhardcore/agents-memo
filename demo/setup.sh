#!/usr/bin/env bash
# Build the throwaway demo runtime: seeded vault (fresh git), isolated pi
# config (real auth/models/skills, vaultPath -> demo vault), project + scenes
# dirs. Safe to re-run; wipes demo/runtime/ first. runtime/ is gitignored.
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="$DEMO_DIR/runtime"
VAULT="$RUNTIME/vault"
CONFIG="$RUNTIME/config"
PROJECT="$RUNTIME/project"
SCENES="$RUNTIME/scenes"
REAL_CFG="$HOME/.pi/agent"
PLUGIN_ROOT="$(cd "$DEMO_DIR/.." && pwd)"

rm -rf "$RUNTIME"
mkdir -p "$VAULT" "$CONFIG" "$PROJECT" "$SCENES"

# 1. Seed the vault from the extension's _seed template, fresh git history.
cp -a "$PLUGIN_ROOT/_seed/." "$VAULT/"
(
  cd "$VAULT"
  git init -q
  git add -A
  git -c user.name=demo -c user.email=demo@local commit -qm "Initial vault scaffold"
)
echo "vault seeded: $VAULT ($(git -C "$VAULT" log --oneline -1))"

# 2. Isolated pi config: copy real settings/auth/models, redirect vaultPath.
#    PI_CODING_AGENT_DIR points pi at this dir; HOME stays real so the
#    Obsidian CLI socket (in ~/.obsidian-cli.sock) stays reachable.
cp "$REAL_CFG/settings.json" "$REAL_CFG/auth.json" "$REAL_CFG/models.json" "$REAL_CFG/models-store.json" "$CONFIG/" 2>/dev/null || true
[ -f "$CONFIG/auth.json" ] || echo "WARN: no auth.json copied"
ln -sfn "$REAL_CFG/skills" "$CONFIG/skills"
ln -sfn "$REAL_CFG/bin" "$CONFIG/bin"

python3 - "$CONFIG/settings.json" "$VAULT" <<'PY'
import json, os, sys
path, vault = sys.argv[1:3]
with open(path) as f:
    d = json.load(f)
am = d.setdefault("agentsMemo", {})
am["vaultPath"] = vault
am["autoCommit"] = True
am["bootstrapReadHot"] = "on-demand"
am["bootstrapReadIndex"] = "on-demand"
d["defaultProjectTrust"] = "allow"
d["defaultThinkingLevel"] = "high"
base = os.path.expanduser("~/.pi/agent")
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
print("vaultPath ->", vault)
PY

echo "runtime ready: $RUNTIME"
echo "next: open $VAULT in Obsidian (Open another vault > Open folder as vault),"
echo "then record: cd $SCENES && vhs-record.sh ../../ingest.tape"
