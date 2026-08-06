---
name: ingest
description: Ingest sources into wiki. Extracts entities/concepts, creates/updates pages, cross-references. Supports files and URLs.
when_to_use: Use when the user provides a URL or file path to integrate into the wiki as structured pages.
model: opus
effort: high
user-invocable: true
allowed-tools: Agent Bash Read WebFetch
---
Read source, write wiki pages, cross-reference everything. Single source typically touches 8-15 pages.

## I/O
- Input: URL, file path, or image path.
- Output: Wiki pages, `.raw/` archive, index/log/hot-cache updates.

## Process
1. **Pre-process**: Determine input type (URL/image/file path) and follow the type-specific flow in `references/flows.md`. Archive result to `.raw/` with frontmatter (`source_url`, `fetched`). Hash-check `.raw/.manifest.json` to skip re-processed sources.
2. **Collaborate**: Discuss emphasis, granularity, context with user. Wait for response unless "auto-ingest" or "just ingest it".
3. **Extract**: Dispatch `agents/memory-ingest.md` with `source_path`, `vault_path`, `emphasis`. Agent creates/updates pages.
4. **Reconcile**: Update `wiki/index.md`, `wiki/log.md`, `wiki/hot.md`.

## Rules
- Do not modify `.raw/`. Do not create duplicates. Do not skip log/hot-cache updates.
- If new info contradicts existing pages, use `[!contradiction]` callout — never silently overwrite.
- Read hot.md → index.md → 3-5 existing pages max. Use PATCH for edits.
