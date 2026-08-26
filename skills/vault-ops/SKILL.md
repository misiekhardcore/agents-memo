---
name: memo-vault-ops
description: Vault operations protocol — CLI verbs, slugging, indexing, active enforcement, bypass list. Reference for skill I/O.
user-invocable: false
---
# Vault Operations Reference

Single source of truth for **skill-author operational patterns** — when and why to call each CLI verb, the slugification pipeline, indexing/log/hot-cache protocols, active enforcement, and the canonical bypass list. Skills reference this file from their `## Vault I/O` section instead of restating patterns inline.

For the CLI mechanics themselves — full verb table, output formats, exit codes, `content=` escape rules, canvas handling, re-spike procedure — see `${MEMO_PLUGIN_PWD}/_shared/cli.md`.

## 1. CLI verbs at a glance

All vault operations must use the `obsidian` CLI (routed via `scripts/obsidian-cli.sh`). The PreToolUse `Bash` hook rewrites bare `obsidian` calls transparently; the PreToolUse `Read|Write|Edit` hook denies direct file-tool access to vault paths (see §5).

Verb selection at a glance:

|Goal|Verb|
|-|-|
|Read a vault page|`obsidian read path=<page>`|
|Create a new page|`obsidian create path=<page> content="..."`|
|Overwrite a page in full (e.g. `wiki/hot.md`)|`obsidian create path=<page> overwrite=true content="..."`|
|Prepend to the top (e.g. `wiki/index.md`, `wiki/log.md`)|`obsidian prepend file=<page> content="..."`|
|Append to the bottom|`obsidian append file=<page> content="..."`|
|Append to `daily/*.md` (race-safe)|`obsidian create-or-append file=<page> template="..." content="..."`|
|Set / read / remove a single frontmatter property|`obsidian property:set` / `property:read` / `property:remove`|

`overwrite=true` on `daily/*.md` is forbidden (issue #98 race guard); use `create-or-append` for body and `property:set` for frontmatter.

**Authoritative verb table with output formats and full argument lists:** see `cli.md §3`.

## 2. The Slugification Pipeline

Never hand-craft slugs. Always use the `slug.sh` script to ensure Unicode normalization and separator collapsing.

```bash
# Pattern: Title/URL -> Slug
slug=$(bash "${MEMO_PLUGIN_PWD}/scripts/slug.sh" "<input_string>")
```

## 3. Indexing & Log Patterns

### Index Section Insertion

Use the read-splice-overwrite pattern via `scripts/index-section-insert.sh`.

- **Target:** `wiki/index.md`
- **Entry Format:** `- [[<slug>|<Display Name>]] — <one-line description>`
- **Logic:** Inserts immediately after the matching heading (e.g., `## Concepts`).

```bash
bash "${MEMO_PLUGIN_PWD}/scripts/index-section-insert.sh" \
  wiki/index.md "$section_heading" "$new_entry"
```

### Log Prepending

New entries always go to the TOP of `wiki/log.md`.

```bash
obsidian prepend file=wiki/log.md content="## [YYYY-MM-DD] <op> | <title>\n- <details>\n\n"
```

## 4. Hot Cache Protocol

Maintain `wiki/hot.md` after every operation.

- **Format:** Follow `${MEMO_PLUGIN_PWD}/skills/hot-cache-protocol/SKILL.md`.
- **Operation:** Overwrite existing content to keep it a concise (~500 word) summary of recent state — `obsidian create path=wiki/hot.md overwrite=true content="..."`.

## 5. Active Enforcement

Three hooks together enforce that vault I/O via file tools (Read/Write/Edit) routes through the CLI preflight or is an explicitly allowed bypass, and that agents discover the rules at session start. Direct Bash access (e.g. `cat "$VAULT/..."`) is not intercepted:

- `hooks/obsidian-cli-rewrite.sh` (PreToolUse, matcher `Bash`) rewrites bare `obsidian <verb> ...` calls into `scripts/obsidian-cli.sh` invocations, so vault resolution, the version preflight, and exit-code normalization always apply.
- `hooks/block-direct-vault-io.sh` (PreToolUse, matcher `Read|Write|Edit`) **denies** any file-tool call whose `file_path` resolves inside the vault, except the paths in the bypass list below. The deny reason names the correct CLI verb so the agent self-corrects on the next turn.
- A SessionStart / PostCompact injection emits `_shared/INIT.md` when a vault is configured. INIT.md contains the high-level "when to engage / when not to engage the vault" guidance and a lazy-load pointer to this file. The pointer is just a markdown link, so the body of this doc is loaded only when the agent follows it.

`wiki/hot.md` and `wiki/index.md` are **not** exceptions. Both round-trip through the CLI cleanly (`obsidian create overwrite=true`, `obsidian prepend`, `scripts/index-section-insert.sh`).

Both hooks fail-open: missing dependencies, unresolvable vault, or unparseable input always allow the tool call through. Non-vault sessions are never disrupted.

### Canonical bypass list

The only paths where direct `Read` / `Write` / `Edit` on vault files is permitted — because the CLI literally cannot serve the operation:

|Path|Tools|Why CLI can't handle it|
|-|-|-|
|`.raw/**`|`Read`|Source documents not indexed by Obsidian; `obsidian read` returns "not found"|
|`.raw/.manifest.json`|`Write` / `Edit`|Incremental JSON mutation via `jq + mv`; no CLI JSON verb|
|`_attachments/**`|`Read` / `Write` / `Edit`|Binary files (images, PDFs); no CLI binary verb|
|`*.canvas`|`Read` / `Write` / `Edit`|`content=` escape asymmetry corrupts canvas JSON (`cli.md §6`)|
|`wiki/meta/lint-data-*.json`|`Write` / `Edit`|Admin JSON artifact written by `lint-scan.sh`|

Skill and agent specs must not list `Read`, `Write`, or `Edit` for general vault access. When a skill legitimately needs one of the bypassed paths, document the reason inline.
