---
name: braindump
description: Split long-form text into atomic inbox notes. Accepts inline text or file paths. Triage later via /note process.
when_to_use: "/braindump <text or file paths>". Splits text into atomic notes in notes/ inbox.
model: sonnet
effort: medium
user-invocable: true
argument-hint: "[text | filepath ...]"
allowed-tools: Agent Bash Read
---
Split long-form text into atomic inbox notes. Chunks land in `notes/` for later triage via `/note process`.

## I/O
- Input: Space-separated text snippets and/or file paths.
- Output: Atomic notes at `<vault>/notes/YYYY-MM-DD-<slug>.md`, index patch.

## Process
1. **Resolve**: Vault path per `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` §1. Abort if unconfigured.
2. **Parse**: Split input into text vs file arguments. Read files. If images present, Read `${MEMO_PLUGIN_PWD}/skills/image-capture/SKILL.md` first.
3. **Split**: Chunk input into atomic thoughts. See `references/split-rubric.md`.
4. **Capture**: Delegate to `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` with `CHUNKS`, `VAULT_ROOT`, `SOURCE_PROJECT`, `TODAY`, `ORDER_MATTERS`. Inline execution per `references/inline-capture.md`; agent fan-out per `references/agent-fanout.md`.

## Agent vs Inline Decision

|Chunks|Order matters?|Mode|
|-|-|-|
|1|n/a|**Inline** — run CAPTURE on main thread.|
|2–4|yes|**Inline** — chunks run in order so K can MATCH-append to K-1.|
|2–4|no|**Agent fan-out** — one `agents/memory-capture.md` per chunk in parallel.|
|5+|no|**Agent fan-out** — always parallel.|
|5+|yes|**Inline** — sequential order preserved; run in order.|

Order matters for numbered lists, narratives, build-on-each-other arguments.

## Confirmation

**Success:** `Captured N notes: <paths>` (singular "note" when N=1).
**Partial failure:** `Captured N notes: <paths>\n\nFailed: K chunks: <reasons>`.
No NEW/MATCH labels, diff, or reasoning in output.
