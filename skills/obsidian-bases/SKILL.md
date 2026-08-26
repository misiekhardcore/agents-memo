---
name: memo-obsidian-bases
description: Obsidian Bases (.base files) — dynamic tables, cards, lists, filters, formulas.
when_to_use: Creating or editing `.base` files for wiki dashboards.
model: haiku
effort: low
user-invocable: true
allowed-tools: Bash Read
---
Turn vault notes into queryable views (tables, cards, lists, maps). Core Obsidian feature; no plugin needed.

## I/O
- Input: View/filter/formula specifications.
- Output: `.base` YAML file at `wiki/meta/`.

## Process
1. **Plan**: Determine view type (table, cards, list), filters, and properties to display.
2. **Write**: Create `.base` YAML with `filters`, `formulas`, `properties`, `views` sections. See `references/syntax.md` for format, filters, properties, and YAML quoting rules.
3. **Verify**: Embed via `![[path.base]]` in a wiki page. Open in Obsidian to confirm rendering.

## Rules
- See `references/syntax.md` for file format, filters, properties, and view types. See `_shared/obsidian-bases-examples.md` for formula patterns and dashboard templates.
- Do not use Dataview syntax (`from:`, `where:`). Do not use `sort:` at root. Sort per-view via `order:` and `groupBy:`.
- Always guard nullable properties with `if()` in formulas. Subtract dates → access `.days` first.
- Store `.base` files in `wiki/meta/`.
