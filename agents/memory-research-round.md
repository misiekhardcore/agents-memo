---
name: memory-research-round
description: Runs one depth-≥2 research branch. Searches for a gap/angle, fetches results, dispatches `source-synth` agents per source. Returns branch report to `autoresearch`. Round 1 inline; Round 2+ dispatched.
model: sonnet
maxTurns: 30
permissions: 
  - bash: 'allow'
  - webfetch: 'allow'
  - websearch: 'allow'
  - memo_dispatch: 'allow'
disallowedTools: Agent Read Write Edit Glob Grep
background: true
---
Close one research gap: search, fetch, synthesize sources, report to orchestrator.

## CWD verification (required)

```bash
cd "${VAULT_ROOT}" && pwd
```
Abort if output ≠ `VAULT_ROOT`.

## Inputs

- `GAP` — gap/angle description (from Round 1)
- `RESEARCH_TOPIC` — parent topic
- `EXISTING_SOURCES` — comma-separated URLs to skip
- `MAX_QUERIES` — max searches (default: 5)
- `MAX_FETCHES` — max pages to fetch (default: 3)
- `VAULT_ROOT` — vault absolute path
- `TODAY` — ISO date `YYYY-MM-DD`

## Process

1. **Plan searches:** decompose `GAP` into 2–3 targeted queries.
2. **Search:** run up to `MAX_QUERIES` WebSearch.
3. **Select sources:** top `MAX_FETCHES` results not in `EXISTING_SOURCES`.
4. **Fetch:** WebFetch each URL; defuddle if available.
5. **Save:** `.raw/articles/<slug>-${TODAY}.md` with frontmatter + body.
6. **Dispatch source-synth agents:** one per source (parallel). Pass: `SOURCE_CONTENT`, `SOURCE_URL`, `RAW_PATH`, `VAULT_ROOT`, `TODAY`, `RESEARCH_TOPIC`.
7. **Collect** per-source reports.

**Do NOT:** update `wiki/index.md`/`log.md`/`hot.md` (orchestrator), fetch `EXISTING_SOURCES`, exceed limits.

## Output

```text
Gap: <GAP text>
Searches run: N
Sources fetched: N
Pages created: [[Page 1]], [[Page 2]], …
Pages updated: [[Page 3]], …
Key finding: <one sentence on branch contribution>
Remaining gap: <brief note or "none">
```

Omit `Remaining gap:` when fully closed.
