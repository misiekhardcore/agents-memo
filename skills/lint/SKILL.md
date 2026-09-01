---
name: memo-lint
description: Wiki health check. Orphans, dead links, frontmatter gaps. Generates canvas maps and Bases dashboards.
when_to_use: Run after every 10-15 ingests or weekly. Routes to agents/memory-lint.md for actual checks.
model: opus
effort: medium
user-invocable: true
allowed-tools: Agent Bash Read
---
Health check for wiki orphans, dead links, frontmatter gaps. Ask before auto-fixing.

## I/O
- Input: Vault root path.
- Output: Report at `wiki/meta/lint-report-YYYY-MM-DD.md`.

## Process
1. **Scan**: `cd "${VAULT_ROOT}" && pwd && bash "${MEMO_PLUGIN_PWD}/scripts/lint-scan.sh"` → produces `wiki/meta/lint-data-YYYY-MM-DD.json`. Scope per `references/scan-scope.md`.
2. **Audit**: Dispatch `agents/memory-lint.md` with `vault_path=$VAULT_ROOT` and `scope="full"`. Agent runs 17 checks (#1–#2, #6–#17) per `references/checks.md` and drafts report.
3. **Review**: Present report (summary + per-section findings) to user. Ask "Auto-fix or review each?" before applying changes.
4. **Rotate**: `bash $MEMO_PLUGIN_PWD/scripts/prune-lint-reports.sh --force` to keep 3 most recent.
5. **Maintain**: If auto-fixes modified pages, update `wiki/hot.md` per `skills/hot-cache-protocol/SKILL.md`.

## Rules
- Show report before any auto-fix. Safe to auto: checks #1, #2, #6, #9, #10. Review first: deletions, contradictions, merges. Never auto-fix trail integrity (#16).
- If auto-fixes modified pages, update hot.md.
- See `references/checks.md` for per-check detail + auto-fix policy, `references/scan-scope.md` for scanned/excluded folders, `references/conventions.md` for style rules.
