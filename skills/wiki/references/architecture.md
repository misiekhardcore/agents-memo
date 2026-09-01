# Vault Architecture

- **Truth**: Directory map, page-type table, and semantics in `_shared/vault-structure.md`.
- **Peers**: `notes/` (inbox), `daily/` (log).
- **Canvas**: `.canvas` files are first-class documents. `memo-canvas` skill owns them.
- **Sources**: `.raw/` folders are hidden and immutable.

## Hot Cache

`wiki/hot.md`: ~500-word summary of recent context. Protocol in `skills/hot-cache-protocol/SKILL.md`.

## Cross-Project Referencing

Any project can reference this vault. Add this block to other projects'
`AGENTS.md` (pi loads it when the project is the CWD; `~/.pi/agent/AGENTS.md`
for global coverage). The block is wrapped in `<!-- agents-memo:begin --> …
<!-- agents-memo:end -->` HTML-comment markers so `/memo:init` can refresh it
idempotently without touching hand-written content:

```markdown
<!-- agents-memo:begin -->
## Wiki Knowledge Base
Path: /path/to/vault
When needed: (1) read wiki/hot.md, (2) read wiki/index.md, (3) drill into domain pages.
Use it for architectural quirks and complex concepts; skip it for straightforward
questions answerable from common knowledge or the code.
<!-- agents-memo:end -->
```

`/memo:init` offers to append this block to the CWD project's `AGENTS.md` when
initializing from inside a consumer project.

## Vault Initialization

Initialization is owned by the **`/memo:init` extension command**, not this skill:
bootstrap (setup-vault + copy-templates + seed-demo), `git init`, vault
`AGENTS.md` (template in `_seed/AGENTS.md`), optional lint timer
(`bin/install-lint-service.sh`), optional project pointer.

## LLM Responsibilities

1. Route operations to sub-skills.
