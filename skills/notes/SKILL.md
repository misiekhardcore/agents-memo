---
name: notes
description: Capture quick inbox notes without breaking flow. Verbatim, auto-match, per-project filtering, list/triage.
when_to_use: '"/note <text>" for quick capture, "/note list" to view inbox, "/note process" to triage.'
model: sonnet
effort: medium
user-invocable: true
argument-hint: "[text | list | process]"
allowed-tools: Bash Read
---
Capture raw thoughts verbatim in `notes/` without interrupting work. Wiki is polished; notes/ is inbox.

## I/O
- Input: `/note <text>`, `/note list`, `/note process` commands.
- Output: Capture → `<vault>/notes/<slug>.md`. List → rendered bullets. Process → triaged notes.

## Process
1. **CAPTURE**: Extract text → enumerate existing notes → MATCH/NEW per `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` §4 → write with frontmatter per §2 → patch index per §6. See `references/capture.md`.
2. **LIST**: Read frontmatter from all `notes/*.md` via `obsidian properties`. Render pending/deferred bullets reverse-chronologically. Support `--project=<name>` filter. See `references/list.md`.
3. **PROCESS**: Walk pending notes oldest-first. Per note: [s]ave (invoke save skill, delete), [d]efer (patch status to deferred), [x]delete, [q]uit. Summary on exit. See `references/process.md`.

## Rules
- Body is user's verbatim text. No headings, no metadata in body.
- On MATCH-append, separator is blank line + `---` + blank line.
- No tags/types/confirmations beyond the PROCESS action prompt.
- Single URL in capture → offer `/ingest` redirect.
- See `references/examples.md` for end-to-end examples of all subcommands.
