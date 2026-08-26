---
name: memo-image-capture
description: Image capture mechanics — validation, attachment directory, vision-LLM, move/naming, embed syntax, frontmatter field.
user-invocable: false
---
# Image Capture — Common Mechanics

Common contract for all capture skills accepting images.

## Image validation

Validate ALL image paths before any vision-LLM call or file move:

- Path exists and is a readable regular file → continue.
- Path exists but unsupported extension:
  ```text
  Unsupported input type: <ext>. /memo-braindump and capture skills accept text, markdown, and image inputs.
  ```
- Path missing, unreadable, or not a regular file:
  ```text
  Image not found or unreadable: <path>
  ```

Abort on any error. No vision-LLM call, no file move occurs in either error case.

## Attachment directory

1. Resolve `<vault_root>` per `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` §1
2. Ensure `<vault_root>/_attachments/` exists; create silently if absent

For `/memo-braindump`: create once before CAPTURE loop, not per chunk.

## Vision-LLM invocation

Single call including all images + text in user input. Max one per CAPTURE. MATCH path: reuse initial description.

On failure: `Vision processing failed: <reason>. Image not moved, note not created.` Never move on failure.

## Attachment move and naming

Move (not copy) images from their source path to `<vault_root>/_attachments/`. Naming:

- **Note — NEW path:** `<note-slug>.<ext>` for primary image; `<note-slug>-2.<ext>`, `<note-slug>-3.<ext>`, … for additional images in the same note.
- **Note — MATCH path:** use the existing note's slug + collision suffix where N continues from the existing attachment count.
- **Daily:** `<YYYY-MM-DD>-<vision-slug>.<ext>`; collisions: `<YYYY-MM-DD>-<vision-slug>-2.<ext>`, etc.
- **Braindump unassigned:** `<date>-braindump-unassigned-N.<ext>` (N starts at 1, one per unassigned image).

## Embed syntax

Use `![[filename.png]]` in note body.

- `/memo-note` and `/memo-braindump`: embeds at end, after vision description, in input order
- `/memo-daily`: embed(s) indented two spaces under the `HH:MM <description>` bullet; all images for one capture go under the same bullet in input order

## `attachments:` frontmatter field

For `/memo-note` and `/memo-braindump` notes: add (or extend) an `attachments:` list in frontmatter when images are present:

```yaml
attachments: ["filename1.png", "filename2.png"]
```

`/memo-daily` does NOT include an `attachments:` field — daily files are append-only logs, not structured knowledge objects.

## MATCH path with images

1. Reuse initial vision description (no re-invoke)
2. Append after `---` separator per `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` §4 MATCH
3. Move to `_attachments/` with existing slug + collision indices
4. Extend existing `attachments:` list
5. Keep `title:` unless new content broadens scope (if so, rewrite to union; slug unchanged)
