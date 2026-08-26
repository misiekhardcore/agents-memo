# Daily Close — Full Procedure

## Pipeline

1. **Resolve vault** [§1](${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md). Abort if unconfigured.
2. **Parse date** (no arg = today, validate `YYYY-MM-DD`, reject future dates).
3. **Read daily file** `obsidian read path=daily/YYYY-MM-DD.md`. Abort if missing.
4. **Scan for content**: count `## Captures` bullets. If zero, list pending notes via `obsidian files dir=notes format=json`; list wiki candidates via `obsidian files dir=wiki format=json`, then per candidate run `obsidian properties path=<file>` and keep only those with `created:` or `updated:` matching the date. Abort if nothing remains.
5. **Gather input**: if >3 matched files, dispatch `agents/memory-gather.md` (max 20); else read each via `obsidian read path=<file>`. Always read `wiki/hot.md` and `wiki/index.md`.
6. **LLM synthesis** via template below.
7. **Update in-memory**: insert or replace `## Summary` section (idempotent); add optional `## Follow-ups` with bullets. Bump `updated:` frontmatter.
8. **Atomic write** via `obsidian create path=daily/YYYY-MM-DD.md overwrite=true content=...`
9. **Confirm**: `Closed daily/YYYY-MM-DD.md` (omit follow-up count if none).

## Prompt template (step 6)

```text
You are synthesizing a daily capture log for {{ date }}.

## Daily Captures
{{ daily_file_content }}

## Related Activity

### Pending Notes
{{ pending_notes_content_if_any }}

### Wiki Pages Updated on {{ date }}
{{ wiki_pages_content_if_any }}

## Context

### Hot Cache
{{ hot_md_content }}

### Wiki Index
{{ index_md_content }}

## Task

Write a prose summary (1–3 paragraphs) of the day's key insights, decisions, and progress. Then, optionally, add a `## Follow-ups` section with bulleted actionable items.

**Requirements:**
- Prose only in main body; bullets only in `## Follow-ups`.
- Use Obsidian wikilinks (`[[Page title]]` or `[[wiki/path/to/page|alias]]`) to reference pages mentioned in input context. Only link pages that are present; do not invent pages.
- If no follow-ups, omit `## Follow-ups` entirely.

Output only the prose and optional section headers/bullets. Do not include input summaries.
```

## Abort conditions

|Condition|Message|
|-|-|
|No vault configured|`No vault configured — run /memo-wiki init first.`|
|Invalid date|`Invalid date: <input>. Expected YYYY-MM-DD.`|
|Future date|`Cannot close a future date: YYYY-MM-DD.`|
|Daily file missing|`No daily file for YYYY-MM-DD.`|
|Nothing to synthesize|`Nothing to synthesize for YYYY-MM-DD.`|
|LLM/write failure|File left unchanged (no error message aside from tool feedback)|

## Examples

**Close today (no argument):**
```text
user> /memo-daily-close
assistant> Closed daily/2026-04-27.md (3 follow-ups)
```

**Close past date:**
```text
user> /memo-daily-close 2026-04-20
assistant> Closed daily/2026-04-20.md
```

**Re-run (replaces prior summary):**
```text
user> /memo-daily-close
assistant> Closed daily/2026-04-27.md (1 follow-up)
```

**Empty day:**
```text
user> /memo-daily-close 2026-04-15
assistant> Nothing to synthesize for 2026-04-15.
```

**File does not exist:**
```text
user> /memo-daily-close 2026-03-01
assistant> No daily file for 2026-03-01.
```

**Future date:**
```text
user> /memo-daily-close 2026-05-01
assistant> Cannot close a future date: 2026-05-01.
```

**Invalid date:**
```text
user> /memo-daily-close next Monday
assistant> Invalid date: next Monday. Expected YYYY-MM-DD.
```
