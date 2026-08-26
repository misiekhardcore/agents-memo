# LIST Operation (Read)

1. Read frontmatter from all `notes/*.md` (skip index). Call `obsidian properties path=notes/<filename>`. Sort by `updated` descending.
2. Render reverse-chronological bullets:

   ```text
   Pending notes (N):

   - [ ] YYYY-MM-DD [source_project] title
   - [ ] YYYY-MM-DD [source_project] title

   Deferred (M):

   - [~] YYYY-MM-DD [source_project] title
   ```

   Glyphs: `[ ]` pending, `[~]` deferred. Always include both sections; show `(none)` under an empty section.

3. **Filter `--project=<basename>`** — only show notes whose `source_project` matches. Honour the same flag in natural-language form (`"show my inbox for agents-memo"`).

`/memo-note list` includes pending + deferred. `/memo-note process` iterates pending only by default; pass `--include-deferred` to walk both.
