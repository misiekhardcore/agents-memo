---
name: memo-memory-search
description: Look up project knowledge from the wiki memory — decisions, bugs, concepts, prior work. Uses obsidian CLI for fast retrieval instead of grep.
when_to_use: When the user asks about project history, prior decisions, bugs, patterns, or anything documented in the vault. Also when asked "check the vault", "check memory", or "what does the wiki say?"
allowed-tools: Bash
---
# memory-search

Quick vault lookups using obsidian CLI. For full synthesis with filing-back, use the `memo-query` skill.

## Vault I/O

Read `${MEMO_PLUGIN_PWD}/skills/vault-ops/SKILL.md` first, then follow its instructions for vault I/O protocol.

All vault reads use `scripts/obsidian-cli.sh` — never grep, never direct file tools.

## Workflow

1. **Read `wiki/hot.md` first.** If it answers the question, respond immediately with `[[hot]]` citations. No further lookup needed.

2. **Search with obsidian CLI.** For each key term, run:
   ```bash
   obsidian search query=<term>
   ```
   Never use grep. The CLI handles indexing, wikilinks, and frontmatter.

3. **Read candidates cheapest-first.** Escalate only when cheaper reads don't suffice:
   - `obsidian outline path=<page>` — structure check (~5-15 lines)
   - `obsidian read-head path=<page> lines=30` — frontmatter + intro
   - `obsidian grep path=<page> pattern=<term>` — find specific content
   - `obsidian read path=<page>` — full read (most expensive, last resort)

4. **Backlink-check key pages.** For pages that appear central:
   ```bash
   obsidian backlinks path=<page> format=json
   ```
   This surfaces hub membership, canonical references, and trail pages.

5. **Respond with citations.** Always cite sources as `[[wikilink]]`.

6. **If the vault lacks the answer**, say so clearly and offer to run `/memo-query` for deep synthesis.

## Token Discipline

|Read|Cost|Stop if|
|-|-|-|
|`wiki/hot.md`|~500 tokens|Answer found|
|`obsidian search`|~100 tokens|Relevant page found|
|`obsidian outline` / `read-head`|~300 tokens each|Sufficient detail|
|`obsidian read` (full)|~500-2000 tokens|Only when cheaper reads insufficient|

## Reference

- `${MEMO_PLUGIN_PWD}/skills/vault-ops/SKILL.md` — vault I/O protocol
- `scripts/obsidian-cli.sh` — CLI wrapper for all vault reads
