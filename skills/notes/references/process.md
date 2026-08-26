# PROCESS Operation (Update / Delete / Triage)

Walk pending notes one-at-a-time. Route to `/memo-save`, defer, or delete.

`/memo-save` is primary off-ramp. Defer for future-actionable notes. Delete for noise.

## Pipeline

1. Enumerate pending notes (skip `status: deferred` unless `--include-deferred`). Sort by `updated` ascending — oldest first. If none, print `Inbox is empty.` and exit.
2. For each note, read full frontmatter + body and display:

   ```text
   [N/total] YYYY-MM-DD [source_project]
   title: <title>
   body:
   > <verbatim body, indented as a blockquote>

   Action? [s]ave / [d]efer / [x]delete / [q]uit
   ```

3. Wait for single-letter action. Loop on invalid input.
4. **`s` (save)** — invoke `memo-save` skill via Skill tool with note body, frontmatter, explicit name so name-prompt is pre-satisfied. On success:
   - Delete `<vault_root>/notes/<filename>`.
   - Remove the corresponding row from `notes/index.md`. On `/memo-save` failure, leave the note untouched and surface the error.
5. **`d` (defer)** — patch frontmatter: `status: deferred`, bump `updated:` to today. Move row in `notes/index.md` from `## Pending` to `## Deferred`.
6. **`x` (delete)** — delete the file unconditionally. Remove corresponding row from `notes/index.md`.
7. **`q` (quit)** — exit. Remaining notes stay pending.
8. Print one-line summary: `Processed N notes: X saved, Y deferred, Z deleted.`
