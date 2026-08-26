# Canvas Operations

## Reading canvas content

Use the wrapper verb — it strips layout noise and emits structured plain text (groups as `##` sections, edges as a flat resolved list). Use raw JSON only for write operations.

```bash
obsidian read-canvas path=wiki/canvases/<name>.canvas
```

## Status & Create

**`/memo-canvas`**: List `find wiki/canvases -name "*.canvas"`. If exactly one canvas exists, read it via `obsidian read-canvas`. If multiple, list and ask. Report node counts and zone labels.

**`/memo-canvas new [name]`**: Slugify name, create `wiki/canvases/[slug].canvas`, append to `wiki/meta/dashboard.md`.

## Add to Canvas

### `add image [path|url]`

- URL (starts `http`): `curl -sL [url] -o _attachments/images/canvas/[filename]`. Derive filename from URL or use `img-[timestamp].jpg`.
- Local path outside vault: `cp [path] _attachments/images/canvas/`.
- Already vault-relative: use as-is.
- Detect aspect ratio via PIL or `identify`. Position via auto-layout. Report zone and position.

### `add text [content]`

Create text node (width 300, height 120, color 4). Position via auto-layout. Report zone and position.

### `add pdf [path]`

Copy to `_attachments/pdfs/canvas/` if outside vault. Fixed size 400×520. Report page count if determinable.

### `add note [page]`

Search `wiki/` for case-insensitive partial match. Create file node (300×100, no color). Position via auto-layout.

### `zone [name] [color]`

Create group node at max_y + 60 (or 280 if no nodes). Width 1000, height 400. Colors: `"1"`=red, `"2"`=orange, `"3"`=yellow, `"4"`=green, `"5"`=cyan, `"6"`=purple.

### `list`

`find wiki/canvases -name "*.canvas"` (via Bash). For each, read JSON and count nodes by type. Report as: `<path> — N nodes (X images, Y text, Z file, W group)`.

### `from banana`

(if banana-claude installed) Check `wiki/canvases/.recent-images.txt` first. Fallback: `find` images modified in last 10 min. Show 5 most recent if none found. Prompt user to confirm additions.

## Implementation Details

**Auto-positioning**: Read canvas, find target zone, collect existing nodes in zone, flow left-to-right with row wrapping. Full spec in `_shared/canvas-spec.md`.

**ID generation**: Pattern `[type]-[content-slug]-[unix-ts]`. Examples: `img-cover-1744032823`, `text-note-1744032845`, `zone-branding-1744032901`. On collision, append `-2`, `-3`, etc.

**Images**: Detect aspect ratio via PIL or `identify`; use size table in canvas-spec.md.

**Nodes**: Always read canvas before writing. Parse JSON, append new node, write atomically. Update `wiki/index.md` for new canvases only.

## Banana Integration

After any `/banana` run, if the user says "add to canvas", treat it as `/memo-canvas from banana`. When `/banana` finishes, suggest:

> "Add generated images to canvas? Run `/memo-canvas from banana`"

## Session Log

If `wiki/canvases/.recent-images.txt` exists, append any new image path written to `_attachments/images/` during this session (one per line, keep last 20).

## Summary

1. Read canvas-spec.md before editing.
2. Read canvas before writing; parse nodes to avoid collisions.
3. Create `_attachments/images/canvas/` for images.
4. Update `wiki/index.md` on new canvases.
5. Report position and zone after every add.
