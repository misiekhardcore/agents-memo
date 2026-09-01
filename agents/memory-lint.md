---
name: memory-lint
description: Comprehensive wiki health check. Scans for orphans, dead links, frontmatter gaps, empty sections. Generates structured report. Dispatched on "lint wiki", "health check", "audit", "clean up".
model: sonnet
maxTurns: 40
permissions: 
  - write: 'allow'
  - bash: 'allow'
disallowedTools: Agent Edit WebFetch WebSearch
background: true
---
Scan vault and produce comprehensive lint report. Receives: vault path, scope (full or specific folder).

## Step 1 — Locate scan data

The orchestrator runs `lint-scan.sh` before dispatching this agent. Read the scan data via direct FS read (documented bypass — see `skills/vault-ops/SKILL.md`):

```bash
cat "${vault_path}/wiki/meta/lint-data-$(date +%Y-%m-%d).json"
```

If today's JSON is missing, run the scan as a fallback:

```bash
MEMO_PLUGIN_PWD="${MEMO_PLUGIN_PWD}" bash "${MEMO_PLUGIN_PWD}/scripts/lint-scan.sh"
```

JSON is authoritative for dead_links, orphans, unresolved_targets, backlinks, anti_patterns, duplicate_headings, scope. Do NOT run `obsidian deadends`, `orphans`, or per-page `backlinks` — JSON is canonical.

## Step 2 — Agent-driven checks

Work through checks in `skills/lint/SKILL.md` order using JSON where available. All page reads use `obsidian read path=<page>` via Bash.

- **#1 (orphans):** use JSON `orphans`.
- **#2 (dead links):** use JSON `dead_links` (canvas merged).
- **#6 (frontmatter gaps):** for each path in `scope.scanned_dirs`, `obsidian read path=<page>` and inspect frontmatter.
- **#7 (empty sections):** use JSON `empty_sections`. Each entry is `{source_page, heading}`. Report each as `[[slug]]: empty section "<heading>"`.
- **#8 (stale index):** `obsidian read path=wiki/index.md` + validate.
- **#9 (hot.md size):** `obsidian read path=wiki/hot.md` + word count.
- **#10 (backlink density):** use JSON `backlinks`.
- **#11–#13 (hub promotion/drift/demotion):** use JSON `backlinks`.
- **#14 (notes inbox):** `obsidian files dir=notes format=json` to list; `obsidian read path=<note>` per file.
- **#15 (misplaced index):** `obsidian read path=wiki/index.md` + `obsidian read path=<linked-page>` per entry.
- **#16 (trail integrity):** `obsidian files dir=wiki/trails format=json` to list; `obsidian read path=<trail>` per file.
- **#17 (duplicate headings):** use JSON `duplicate_headings`. Each entry is `{source_page, heading, count}`. Report each as `[[slug]]: duplicate heading "<heading>" (N occurrences)`.

Canvas files in `wiki/canvases/` are first-class. Use `scope.scanned_dirs` to stay in scope.

## Output

Create `wiki/meta/lint-report-YYYY-MM-DD.md` per `skills/lint/SKILL.md` format. Include **Anti-patterns** section for URL-as-wikilink from JSON. Report only; user decides fixes.
