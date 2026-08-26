---
name: memo-obsidian-markdown
description: Obsidian Flavored Markdown syntax. Wikilinks, embeds, callouts, properties, tags, math.
user-invocable: false
allowed-tools: Read
---
# obsidian-markdown

Reference for Obsidian Flavored Markdown: wikilinks, embeds, callouts, properties, tags, math. Check `references/syntax-tables.md` for full syntax tables.

## Quick Reference

**Wikilinks**: `[[Note Name]]`, `[[Note Name|Display Text]]`, `[[Note Name#Heading]]`, `[[Note Name#^block-id]]`. Case-sensitive; no path needed if unique. Use `[[Folder/Note]]` to disambiguate.

**Embeds**: `![[Note Name]]`, `![[Note Name#Heading]]`, `![[image.png]]`, `![[image.png|300]]`, `![[document.pdf]]`, `![[audio.mp3]]`. The `!` makes it inline.

**Callouts**: `> [!type]` (with optional `-` for closed, `+` for open). Types: note, abstract, info, todo, tip, success, question, warning, failure, danger, bug, example, quote, contradiction. Full list in syntax-tables.

**Properties (Frontmatter)**: Flat YAML. Dates as `YYYY-MM-DD`. Wikilinks quoted: `"[[Page]]"`. Lists as `- item`. Example:
```yaml
---
type: concept
title: "Title"
created: 2026-04-08
updated: 2026-04-08
tags:
  - tag-one
  - tag-two
status: developing
related:
  - "[[Other Note]]"
---
```

**Tags**: Inline `#tag-name` or nested `#parent/child-tag`. In frontmatter, use list format (no `#`).

**Text**: `**bold**`, `*italic*`, `~~strikethrough~~`, `==highlight==`, `` `code` ``.

**Math**: Inline `$E = mc^2$` or block `$$ ... $$` (MathJax/KaTeX).

**Code/Tables/Mermaid**: Fenced triple-backtick blocks. Mermaid renders natively; supports graph, sequenceDiagram, gantt, classDiagram, pie, flowchart.

**Footnotes**: `Text.[^1]` then `[^1]: Content`.

**Anti-patterns**: No `[text](path.md)`, no HTML in callouts, no `##` in callout body, no inline `tags: [a,b,c]`, no ISO datetime in frontmatter.
