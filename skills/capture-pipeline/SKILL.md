---
name: capture-pipeline
description: Protocol skill — run CAPTURE pipeline for verbatim chunks. Called from /braindump.
user-invocable: false
---
Protocol skill for capture surfaces. Handles agent vs inline decision, per-chunk MATCH/NEW, index patching. Not user-invocable; Read `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` first, then follow its pipeline.

## I/O
- Input: `CHUNKS`, `VAULT_ROOT`, `SOURCE_PROJECT`, `TODAY`, `ORDER_MATTERS` (passed via context).
- Output: Confirmation text, `notes/index.md` patches.

## Process
1. **Resolve and shape**: Vault path per `references/vault-frontmatter-slug.md` §1. Frontmatter per §2. Slug per §3.
2. **Match or New**: Per `references/match-new.md` — enumerate, decide MATCH/NEW, write or append.
3. **Patch index or append daily**: Per `references/index-daily.md`.
4. **Confirm**: `Captured N notes: <paths>`. On partial failure: `Failed: K chunks: <reasons>`.

## Rules
- Parallel agents cannot MATCH-append to each other's notes (concurrent). They must be run inline if chunks would merge.
- Agents dispatched by a calling skill do NOT patch the index — the orchestrator owns that write.
- No NEW/MATCH labels. No diff. No reasoning in output.
- For attachment handling, Read `${MEMO_PLUGIN_PWD}/skills/image-capture/SKILL.md` first.
