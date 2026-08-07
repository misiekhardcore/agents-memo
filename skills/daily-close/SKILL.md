---
name: daily-close
description: Synthesize a day's captures into a prose summary. Idempotent; re-run replaces prior summary.
when_to_use: '"close today", "wrap up today", "synthesize today". Run at end of day.'
model: sonnet
effort: medium
user-invocable: true
allowed-tools: Bash Agent
---
Synthesize `daily/YYYY-MM-DD.md` into prose summary with optional follow-ups. Idempotent.

## I/O
- Input: Daily file path, date (default today).
- Output: `## Summary` (and optional `## Follow-ups`) appended to daily file.

## Process
1. **Resolve**: Vault path — abort if unconfigured.
2. **Parse**: Date (default today). Reject future/invalid.
3. **Read**: Daily file — abort if missing. Scan content — abort if nothing to synthesize.
4. **Gather**: Read daily captures, dated notes, wiki pages, hot.md, index.md.
5. **Synthesize**: LLM synthesis per prompt template. Append `## Summary` to daily file.
6. **Confirm**: `Closed daily/YYYY-MM-DD.md`.

## Rules
- Idempotent: re-run replaces prior `## Summary` section.
- Abort on: no vault, invalid/future date, missing daily file, nothing to synthesize, LLM/write failure.
- Full procedure: see `references/pipeline.md`.
