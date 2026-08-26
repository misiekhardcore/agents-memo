# Vault Structure

Cross-skill conventions: directory layout, page types, confidence tagging, typed-relationship semantics.

Read on demand.

## Directory Map

|Directory|Type value|What goes here|Naming convention|
|-|-|-|-|
|`wiki/concepts/`|`concept`|Patterns, techniques, ideas, how-things-work explanations|Title Case or kebab-case slug; no "the" prefix|
|`wiki/entities/`|`entity`|Named real-world things: people, tools, products, orgs, repos|Proper noun as named in the source|
|`wiki/sources/`|`source`|One page per ingested source — metadata, key findings, links to derived pages|`<slug>` matching the `.raw/` filename|
|`wiki/solutions/`|`solution`|Concrete recipes: how to accomplish a specific task end-to-end|Verb phrase, e.g. `register-vault-with-cli`|
|`wiki/comparisons/`|`comparison`|Side-by-side analysis of 2+ alternatives|`<A>-vs-<B>` or `comparing-<topic>`|
|`wiki/questions/`|`question`|Open questions; closed questions link to the answer|Question as written, e.g. `why-tokens-compound`|
|`wiki/domains/`|`domain`|Universal hub root for domain hubs; each hub is `wiki/domains/<slug>/_index.md`|kebab-case slug, e.g. `machine-learning`, `sophia`|
|`wiki/trails/`|`trail`|One reading-order record per `/memo-autoresearch` run — lists atomic notes in argument order with one-line annotations. Created lazily on first run; never edited post-emission|`Trail: [Topic] (YYYY-MM-DD)` — date suffix distinguishes multiple runs on the same topic|
|`wiki/meta/`|`meta`|Index files, log, hot cache, dashboards — structural pages|Short functional names: `index`, `log`, `hot`|

Per-folder `_index.md` files are NOT part of this layout. Curation is `wiki/domains/<slug>/_index.md` only. Other folders are flat leaf directories.

## Hub Membership

Forward-only model. No `domain:` field on leaves.

|Direction|Encoding|
|-|-|
|Hub → leaf|`related:` in `wiki/domains/<slug>/_index.md`|
|Leaf → hub|Backlink resolution (`obsidian backlinks` filtered by `type: domain`)|

Benefits: single source of truth (hub), no dual-write, leaves can belong to multiple hubs. Below ~10 leaves, no hub; queries fall back to grep + tags. See `skills/lint/SKILL.md` for thresholds.

## Confidence Tagging

|Value|Meaning|
|-|-|
|`EXTRACTED`|Claims from document (source pages, literal quotes)|
|`INFERRED`|LLM-derived (most concept/entity pages)|
|`AMBIGUOUS`|Conflicting signals; needs human review|

`AMBIGUOUS` pages must list conflicts in `open_questions` or `## Perspectives`.

`evidence:` is required for `INFERRED` and `AMBIGUOUS` pages.

**Default by type:** source→`EXTRACTED`, concept→`INFERRED`, entity→`INFERRED`, meta→`EXTRACTED`, trail→`EXTRACTED`.

## Typed Relationships

Alongside `related:`, use typed fields when the semantic is unambiguous:

|Field|Meaning|
|-|-|
|`supersedes:`|This page replaces the listed page(s)|
|`contradicts:`|This page's claims conflict with the listed page(s)|
|`uses:`|This page/concept applies or depends on the listed page(s)|
|`depends_on:`|Stronger dependency — can't function without the listed page(s)|
|`caused:`|This page describes something that caused the listed outcome(s)|
|`fixed:`|This page describes a fix for the listed issue(s)|
|`implements:`|This page is an implementation of the listed spec/pattern(s)|

All typed relationship fields are optional flat lists. Keep `related:` for general or untyped links. Add typed fields only when the semantic is genuinely unambiguous.

For the YAML shape of these fields, see `${MEMO_PLUGIN_PWD}/_shared/frontmatter.md` §Typed Relationship Fields.
