# CAPTURE Operation (Create)

Goal: persist verbatim text with minimal metadata. No conversation context, no auto-tagging, no questions.

## Pipeline

1. **Extract arguments** from the user's message. For `/memo-note <args>` and `/memo-dump <args>`, capture everything after the trigger phrase as a single raw argument string. Scan non-destructively for image-path tokens (any token resolving to a path or carrying a supported image extension) and URL tokens. All remaining non-path, non-URL tokens form a single verbatim text segment — joined in original order with single spaces. Preserve relative order of text, paths, and URLs.

2. **Image routing.** If any image paths are present → read `${MEMO_PLUGIN_PWD}/skills/image-capture/SKILL.md`. Follow that file for the full image-input path; skip steps 3–4 below.

3. **URL detection (text-only, no images).** If the argument is a single URL:
   - Prompt exactly once: `Detected URL: <url>. Ingest via /memo-ingest? [y/n]`
   - Read one response only. Treat case-insensitive `y` or `yes` as consent. Any other response = "no". Do not re-prompt.
   - If consent → invoke `/memo-ingest`. On success: `Ingested via /memo-ingest: <wiki-page>`. Exit.
   - Otherwise → proceed, treating the URL as verbatim text.

4. **Extract text for MATCH/NEW.** Everything after trigger phrase, verbatim — no rewriting, no summarising.

5. **Resolve** `<vault_root>` per `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` §1. Compute today as `YYYY-MM-DD`. Compute `source_project = basename(cwd)`. If `<vault_root>/notes/` does not exist, create directory and initialize `notes/index.md` from `_seed/notes/index.md`.

6. **Enumerate** existing notes and decide MATCH or NEW per `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` §4. Skip `notes/index.md` and `status: deferred`; cap at 20 most recent.

7. **MATCH or NEW path** per `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` §4. Slug via `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` §3. Frontmatter from `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` §2; body is verbatim text.

8. **Update `notes/index.md`** per `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` §6.

9. **Confirm** with one terse line:
   - NEW: `Captured to notes/YYYY-MM-DD-<slug>.md`
   - MATCH: `Appended to notes/YYYY-MM-DD-<slug>.md`

Do **not** print the diff, match reasoning, or attachment details.
