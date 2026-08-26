# Fallback

## Gap Handling

If the question cannot be answered from the wiki:

1. Say clearly: "I don't have enough in the wiki to answer this well."
2. Identify the specific gap: "I have nothing on [subtopic]."
3. Suggest: "Want to find a source on this? I can help you search or process one."
4. Do not fabricate; if the wiki lacks the answer, say so and offer to run `/memo-autoresearch`.

## Index Format Reference

The master index (`wiki/index.md`) has section headers:

- **Domains**: `[[Domain Name]]: description (N sources)`
- **Entities**: `[[Entity Name]]: role (first: [[Source]])`
- **Concepts**: `[[Concept Name]]: definition (status: developing)`
- **Sources**: `[[Source Title]]: author, date, type`
- **Questions**: `[[Question Title]]: answer summary`

Scan section headers first to determine which sections to read.

## Domain Hub Format

Domain hubs at `wiki/domains/<slug>/_index.md`. Curated entry point for one cluster:

```markdown
---
type: domain
title: "Knowledge Management"
owns_folder: false
subdomain_of: ""
page_count: 12
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [domain, knowledge-management]
status: developing
confidence: EXTRACTED
evidence: []
related:
  - "[[page|display name]]"
---

# Title

One-paragraph hub description.

## Core concepts

- [[page]] — one-line

## Sources

- [[source]] — origin
```

Reach a hub via `wiki/domains/<cluster-tag>/_index.md` (step 3 of standard flow) or via leaf→hub backlink traversal.

Per-folder `<folder>/_index.md` files are not used. Folders like `concepts/`, `entities/`, `sources/` are flat; cross-folder navigation goes through hubs.

## Standard Mode Fallback

Step 4 of standard workflow: read `wiki/index.md` only when steps 1–3 fail (no hot-cache hit, no tag cluster, no hub). Scan section headers; identify candidate pages; rank by backlinks.
