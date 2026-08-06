# Seed-Brief — Spawn-time Context Packaging Format

## Purpose

A **seed-brief** packages critical state—repo, branch, active_issue, scope, progress—as typed YAML inside a `<seed-brief>` XML block passed to spawned agents or sub-skills at spawn time. It solves the **zero context inheritance** problem: when you spawn a new Claude session with `Agent()` or call a sub-skill, the spawned agent arrives with no knowledge of prior work.

The receiving agent uses the seed-brief to self-configure without re-researching the context.

## When to Use

Use seed-briefs when spawning worker agents via the `memo_dispatch` tool or calling protocol skills by reading their SKILL.md files to hand off context.

Do NOT use for:
- **Mid-cycle state within the same worktree.** Use `NOTES.md` for findings, failing AC, prior decisions.
- **Phase-to-phase handoff.** Lives in the GitHub issue body (## Requirements, ## Implementation plan).

## Format

Typed YAML inside a `<seed-brief>` XML tag. The orchestrator embeds it directly in the spawned agent's prompt:

```
<seed-brief>
repo: owner/repo
branch: feat/my-feature
active_issue: 155
max_cycles: 3
scope: "Phase 0c+0d+0e: Seed-brief contract + protocol skill promotions"
payload:
  resources:
    - _shared/seed-brief.md
    - _shared/
    - skills/*/SKILL.md
  progress: |
    ## Task list
    - [ ] Task one
    - [ ] Task two
</seed-brief>
```

**Rules:**
- Raw YAML indentation. No inner fence (no triple-backtick).
- `payload.progress` uses pipe `|` block scalar for multi-line task lists.
- Placed in the spawned agent's initial prompt.

## Required Fields

|Field|Type|Notes|
|-|-|-|
|`repo`|string|Format: `owner/repo`. Verified against `git remote -v` by orchestrator before spawning.|
|`branch`|string|Format: `feat/<slug>`. Verified against `git rev-parse --abbrev-ref HEAD`.|
|`active_issue`|integer|GitHub issue number.|
|`max_cycles`|integer|Max spawn/retry cycles before escalation.|
|`scope`|string|One-line description of the work scope.|
|`payload`|object|Structured context: `resources` (file list), `progress` (task list with checked/unchecked items).|

## Orchestrator Duties

1. **Run repo/scope-preflight once at entry.**
2. **Construct seed-brief** with all required fields.
3. **Checkpoint NOTES.md** before every skill dispatch or agent spawn so the worktree retains sufficient state to reconstruct if the session dies mid-spawn.
4. **Pass to every agent spawn.**
5. **Verify completeness** on return: read spawned agent's output; if incomplete, re-spawn with updated `payload.progress`.

## Rules

- **Caller-side only.** Receivers do not detect or parse as a mode switch — they just receive the context.
- **Brief is spawn-time only.** Inter-cycle state within the same worktree lives in `NOTES.md`.
- **No brief bloat.** Cap to required fields; verbose context overflows token budget.
- **Sanity check every field.** Orchestrator verifies repo and branch against `git` before constructing.
