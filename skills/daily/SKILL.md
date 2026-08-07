---
name: daily
description: Append a timestamped bullet to today's daily log. One line per call.
when_to_use: '"/daily <text>", "log this", "add to today''s log". Append-only — no list or triage.'
model: haiku
effort: low
user-invocable: true
argument-hint: "[text]"
allowed-tools: Bash Read
---
Append timestamped bullet to `daily/YYYY-MM-DD.md`. Use `/daily` for time-anchored observations, `/note` for knowledge fragments.

## I/O
- Input: Verbatim text, optional image paths.
- Output: Bullet appended to `<vault>/daily/YYYY-MM-DD.md`.

## Process
1. **Extract**: Arguments — verbatim text + optional image paths. If images present, Read `${MEMO_PLUGIN_PWD}/skills/image-capture/SKILL.md` first.
2. **Resolve**: Vault path per `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` §1. Abort if unconfigured.
3. **Compute**: `YYYY-MM-DD` and `HH:MM` from current time.
4. **Append**: `obsidian create-or-append file=<vault>/daily/YYYY-MM-DD.md template="..." content="<bullet>"`.
5. **Bump**: `obsidian property:set path=<file> property=updated value=<ISO timestamp>`.
6. **Confirm**: `Logged to daily/YYYY-MM-DD.md`.

## Rules
- Idempotent: multiple calls in same minute share `HH:MM` prefix. Every call adds a new bullet.
- No MATCH/NEW, no inbox, no triage. Append-only log.
- Frontmatter schema: see `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` §2.
