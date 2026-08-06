# Reading Heuristics

Cheapest-read-first escalation for wiki pages. Use in standard and deep modes after candidate pages are identified.

## Escalation Chain

|Read method|Cost (approx)|Use when|
|-|-|-|
|`obsidian outline path=<page>`|~5-15 lines|Check structure before reading body|
|`obsidian read-head path=<page> lines=30`|~30 lines|Frontmatter + first paragraph is enough|
|`obsidian grep path=<page> pattern=<term>`|~5-15 lines|Need specific content without full read|
|`obsidian read path=<page>`|full page|Cheaper reads don't provide enough detail|

Only fall back to full `obsidian read` when cheaper reads don't suffice. Follow wikilinks to depth-2 for key entities. No deeper.

## Token Discipline

Start with cheapest resource; stop when the question is answered.

|Start with|Cost (approx)|When to stop|
|-|-|-|
|hot.md|~500 tokens|If it has the answer|
|index.md|~1000 tokens|If you can identify 3-5 relevant pages|
|3-5 wiki pages|~300 tokens each|Usually sufficient|
|10+ wiki pages|expensive|Only for synthesis across the entire wiki|

If hot.md has the answer, respond without reading further. For the full hot-cache protocol, see `${MEMO_PLUGIN_PWD}/skills/hot-cache-protocol/SKILL.md`.

## Backlink Ranking

`obsidian backlinks path=<leaf> format=json` returns `{"entries": [...], "file": "<path>"}`. The `entries` field count = inbound citations. A heavily cited atomic note must surface in the top-N even if its outbound `related:` is sparse.

### Leaf→Hub Traversal

If a candidate page is a leaf and the answer needs wider topic context, run `obsidian backlinks path=<leaf> format=json` and filter entries whose frontmatter `type: domain`. That file is the leaf's containing hub. Hub membership is forward-only (hubs link to leaves; leaves never declare membership). Below the hub threshold no hub exists — that is expected, not a gap.

### Synthesis→Trail Discovery

When a candidate page has `type: synthesis` (a `Research: [Topic]` page from `/autoresearch`), discover its trail:

1. Run `obsidian backlinks path=<synthesis-path> format=json`.
2. For each entry, run `obsidian properties path=<entry>` to read frontmatter and filter to `type: trail`.
3. **Multi-trail rule.** If >1 trail backlinks the synthesis, pick the **most recent** by `YYYY-MM-DD` date suffix on the filename (canonical, not `research_run:` field). Read only that trail. After answering, append:
   ```text
   *N earlier trail(s) exist on this topic — say 'compare trails' to read all.*
   ```
   Skip the line when only one trail exists.
4. **`compare trails` follow-up.** If the user replies "compare trails" (or equivalent), read all trails oldest-first and synthesize an evolution view.

**Trail vs hub** — both reachable via backlinks, disambiguated by `type: trail` vs `type: domain`. Read the trail when re-entering a research topic; read the hub when exploring a domain.

**Fallback.** If no trail exists for a synthesis page, fall back to standard backlink/hub traversal. No trail is not a gap — `/autoresearch` now emits exactly one trail per run.
