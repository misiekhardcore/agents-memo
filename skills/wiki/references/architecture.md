# Vault Architecture

- **Truth**: Directory map, page-type table, and semantics in `_shared/vault-structure.md`.
- **Peers**: `notes/` (inbox), `daily/` (log).
- **Canvas**: `.canvas` files are first-class documents. `canvas` skill owns them.
- **Sources**: `.raw/` folders are hidden and immutable.

## Hot Cache

`wiki/hot.md`: ~500-word summary of recent context. Protocol in `skills/hot-cache-protocol/SKILL.md`.

## Cross-Project Referencing

Any project can reference this vault. Add this to other projects' `CLAUDE.md`:

```markdown
## Wiki Knowledge Base
Path: /path/to/vault
When needed: (1) read wiki/hot.md, (2) read wiki/index.md, (3) drill into domain pages.
Do NOT read for general coding questions.
```

## LLM Responsibilities

1. Set up vault and scaffold structure.
2. Route operations to sub-skills.
3. Maintain hot cache and index/log updates after every operation.
4. Use frontmatter, wikilinks, and the forward-only hub model.
5. Never modify `.raw/`.
