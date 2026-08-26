---
name: memo-defuddle
description: Strip ads, nav, boilerplate from web pages. Saves 40-60% tokens. Use before URL ingestion.
when_to_use: Before ingesting a URL to strip ads, navigation, and boilerplate.
model: haiku
effort: low
user-invocable: true
allowed-tools: Read Bash
---
Extract clean markdown from web pages. Optional but saves 40-60% tokens and produces cleaner wiki pages.

## I/O
- Input: URL or local HTML file path.
- Output: Cleaned markdown to stdout or `.raw/` file.

## Process
1. **Check**: Run `defuddle --version`. If not installed, fall back to WebFetch.
2. **Clean**: `defuddle <url|path>` for stdout, or redirect to `.raw/articles/slug-YYYY-MM-DD.md`. See `references/install-usage.md` for all command variants and when-to-use guidance.
3. **Archive**: Prepend frontmatter (`source_url`, `fetched`) to saved file per `references/install-usage.md`.

## Rules
- Use for articles/blogs/docs with surrounding content. Skip for clean markdown/PDF, dashboards, structured data.
- If not installed, use WebFetch directly — less clean but workable.
- `/memo-ingest` calls defuddle automatically when available.
