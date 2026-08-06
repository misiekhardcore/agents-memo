# Ingestion Flows

Use the type-specific flow below before proceeding to SKILL.md Process step 2 (Collaborate).

## URL Ingestion
1. **Fetch**: `WebFetch` → optionally `defuddle` URL to strip clutter.
2. **Slug**: Derive via `bash ${MEMO_PLUGIN_PWD}/scripts/slug.sh "url-last-segment"`.
3. **Archive**: Save to `.raw/articles/slug-YYYY-MM-DD.md` with frontmatter (`source_url`, `fetched`).
4. **Proceed** to SKILL.md Process step 1 (Pre-process).

## Image/Vision Ingestion
1. **Read**: Process image natively.
2. **Describe**: Extract text (OCR), identify concepts, entities, diagrams.
3. **Slug**: Derive via `slug.sh` from filename.
4. **Archive**: Save description to `.raw/images/slug-YYYY-MM-DD.md` with frontmatter (`source_type: image`, `original_file`, `fetched`).
5. **Attachment**: Copy image to `_attachments/images/slug.ext`.
6. **Proceed** to SKILL.md Process step 1 (Pre-process).

## Batch Ingest
Use when the user provides multiple sources (URLs or file paths).
1. **Fan-out**: For each source, follow the type-specific flow above, then dispatch one `agents/memory-ingest.md` per source in parallel.
2. **Wait**: Collect all agent reports.
3. **Cross-reference**: Identify connections across sources.
4. **Aggregate**: Update index, hot cache, and log **once** at the end (skip SKILL.md Process step 4 per-source).
