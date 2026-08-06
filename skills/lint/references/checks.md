# Lint Checks (1–16)

## Check #1: Orphan Pages

Source: `orphans` array in `lint-data-YYYY-MM-DD.json`. Wiki pages (`.md` and `.canvas`) with no inbound wikilinks. `wiki/trails/` and `notes/` already excluded. Trails are designed-orphan (forward-only model).

## Check #2: Dead Links

Source: `dead_links` array. Each entry: `{source_page, link_text}`. A wikilink in `source_page` that doesn't resolve. Canvas dead links merged into same array. Findings in `wiki/trails/` surfaced but **never auto-fixed** — trails frozen at write time.

**Anti-pattern note:** URL-as-wikilink (e.g. `[[https://...]]`) in `anti_patterns` array. Report in dedicated **Anti-patterns** section; do NOT count toward dead-link total.

## Check #6: Frontmatter Gaps

Pages missing required fields: `type`, `status`, `created`, `updated`, `tags`, `confidence`. Flag missing `evidence:` when `confidence:` is `INFERRED` or `AMBIGUOUS` (per `_shared/frontmatter.md` rule 7).

## Check #7: Empty Sections

Source: `empty_sections` array. Each entry: `{source_page, heading}`. A heading (`##` or deeper) with no non-blank content before next heading/EOF. Frontmatter and fenced code excluded.

## Check #8: Stale Index Entries

Items in `wiki/index.md` pointing to renamed or deleted pages.

## Check #9: Hot.md Size Budget

Count words in `wiki/hot.md` (spec: 500 words).
- **WARN** if > 500 (spec limit per `${MEMO_PLUGIN_PWD}/skills/hot-cache-protocol/SKILL.md`).
- **FAIL** if > 750 (50% buffer exceeded).
- Remediation: move entries older than 2 weeks to `wiki/log.md`; trim `## Last Updated` to 3–5 items.

## Check #10: Backlink Density

Source: `backlinks` map in JSON (pre-computed). For every in-scope page, compare inbound count (from JSON) vs. outbound count (frontmatter `related:` length + inline wikilinks). Flag pages where `inbound ≥ 3` **and** `outbound ≤ 1` — heavily cited but weakly linking. These are retrieval-late; prompts targeted cross-linking.

## Check #11: Hub Promotion Candidates

Group all leaves under `wiki/concepts/`, `wiki/entities/`, `wiki/solutions/`, `wiki/sources/` by primary tag (first non-type tag in `tags:`). For each tag-cluster of **≥ 10 leaves**, check whether `wiki/domains/<cluster-tag>/_index.md` exists. If not, surface as promotion candidate — suggest `/wiki promote <tag>`.

## Check #12: Hub Stale-Count Drift

For every `wiki/domains/<slug>/_index.md`, compare frontmatter `page_count:` to actual inbound count from `obsidian backlinks path=wiki/domains/<slug>/_index.md format=json`. Flag drift **> 20%** (either direction). Suggest resync.

## Check #13: Hub Demotion Candidates

For every `wiki/domains/<slug>/_index.md`, count leaves linked from hub's `related:` field. If **< 5**, surface as demotion candidate — cluster below threshold. Recommend growing cluster or merging hub into sibling.

## Check #14: Notes Inbox

Scoped to `<vault_root>/notes/` only. Two checks:

1. **Frontmatter gaps** — flag any `notes/*.md` (excluding `notes/index.md`) missing one of: `type`, `title`, `created`, `updated`, `source_project`, `status`. Optional: `topic`, `tags`.
2. **Index drift** — flag files missing from `notes/index.md`, and rows in `notes/index.md` whose title text doesn't match any note's frontmatter `title:`. Match against frontmatter `title:`, not filenames.

Explicitly skip: orphan, dead-link, stale-claim, contradiction checks (wiki-canonical only).

## Check #15: Misplaced Index Entries

For every wikilink in `wiki/index.md`, verify the entry sits under the section matching its target's `type:` frontmatter.

Type → expected section mapping:
|`type:`|Expected section|
|-|-|
|concept|`## Concepts`|
|source|`## Sources`|
|synthesis|`## Plans & Decisions` (or `## Synthesis`)|
|decision|`## Plans & Decisions`|
|meta|(no section — Navigation row only)|
|domain|`## Domains`|

- **Strays** — entries with no preceding H2 (above first heading) flag as `entry above all sections, expected under <Section>`.
- **Misplacements** — entries under non-matching section flag as `entry under <Current> but type=<X> expects <Expected>`.

Role: safety net, not primary placement. `/save` writes entries directly under correct section. Auto-fix policy: **ask-first**.

## Check #16: Trail Integrity

Scoped to `wiki/trails/*.md`. Trails frozen at write time; integrity checks run against fixed shape.

For each trail:
1. **Required trail-specific frontmatter** — flag missing `topic:`, `research_run:`, or `synthesis:`. Universal fields (`type`, `title`, `created`, `updated`, `tags`, `status`, `confidence`, plus `evidence` when `confidence:` is `INFERRED`/`AMBIGUOUS`) are check #6's responsibility.
2. **Synthesis link resolves** — `synthesis:` is wikilink-by-title (e.g. `[[Research: Topic]]`). Run `obsidian unresolved format=json` once per lint pass; check if stripped link text appears in returned array. If yes, link is dead — flag.
3. **Body is an ordered list** — body (below first H1, excluding optional intro paragraph) must be exactly one ordered Markdown list (`1. …`, `2. …`). Flag if no ordered list, multiple top-level lists, prose interleaved, or nested lists.
4. **Every list item** — each item must contain exactly one `[[wikilink]]` + plain-text annotation. Flag if zero wikilinks, multiple wikilinks, no annotation (residue must be non-whitespace/non-punctuation), or annotation text contains URL or extra wikilink. Inline formatting (bold/italic) OK; links not OK.
5. **No minimum link count** — one-step trail is valid; must NOT be flagged.

Auto-fix policy: **never**. Trails are run-snapshots; rewriting destroys run-record. Findings are advisory.

## Gotchas

- Scan scope: `wiki/{concepts, entities, sources, domains, comparisons, questions, solutions}/`, plus `wiki/index.md`, `wiki/log.md`, `wiki/hot.md`, and `wiki/canvases/*.canvas`.
- Excluded: `wiki/meta/` (lint reports, dashboards), `wiki/trails/` (frozen), `notes/` (checks 14 only), `_archive/`, `_templates/`, `.raw/`.
- Valid wikilink targets: `.md`, `.canvas`, `.base`, `.png`, `.jpg`, `.jpeg`, `.svg`, `.pdf`.
