---
name: memo-canvas
description: Visual layer of the wiki. Add images, text cards, PDFs, and wiki pages to canvas files with zones.
when_to_use: Use to create or modify `.canvas` files, add nodes, organize zones.
model: haiku
effort: low
user-invocable: true
allowed-tools: Bash Read Write
---
Visual layer of the wiki. Add images, text cards, PDFs, wiki pages to infinite visual boards. Read `_shared/canvas-spec.md` before editing.

## I/O
- Input: Canvas name, node type, content path/URL.
- Output: Modified/created `.canvas` file.

## Process
1. **Open**: `/memo-canvas` → list existing canvases. `/memo-canvas new [name]` → create slug, write `wiki/canvases/<slug>.canvas`, append to dashboard. See `references/operations.md` § Status & Create.
2. **Add**: Select node type per `references/operations.md` § Add to Canvas — image, text, pdf, note, zone, list, from-banana. Dimensions and colors per `references/node-templates.md`.
3. **Position**: Per `references/operations.md` § Auto-positioning. Read canvas, find target zone, flow left-to-right with row wrapping. Auto-detect aspect ratio for images. Report position and zone.
4. **Commit**: Parse JSON, append new node, write atomically. Update `wiki/index.md` for new canvases only.

## Rules
- Read canvas before every write. Never reuse IDs — pattern: `[type]-[content-slug]-[unix-ts]`.
- Write tool is permitted only for `*.canvas` and `_attachments/**` paths (per `_shared/vault-ops.md` §5 bypass list). All other vault writes use obsidian CLI.
- Banana integration: after `/banana`, offer "Add generated images to canvas?".
