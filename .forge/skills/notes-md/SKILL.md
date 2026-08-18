---
name: notes-md
description: In-phase NOTES.md lifecycle protocol — create on entry, checkpoint before and after significant work, update after decisions, leave on exit.
---
# NOTES.md — In-Phase Progress Ledger

`NOTES.md` is the in-phase progress ledger for orchestrators and other agents
working in a forge workspace. It survives LLM turn boundaries: in-context recall
rot-degrades, the file does not. Read it on demand when creating, updating, or
harvesting — do not preload.

## Where it sits

Two layers, two authorities:

|Layer|Where|Lifetime|Authoritative for|
|-|-|-|-|
|`NOTES.md`|Worktree root, committed|This phase|In-flight state: current task, progress, decisions, next action|
|GitHub issue / PR|Remote|Cross-phase|Acceptance criteria, locked decisions, handoff state|

- **While working** — write to `NOTES.md` (phase-local ledger).
- **Between sessions on the same feature** — resume from `NOTES.md`.
- **Between phases** — the issue and PR body carry cross-phase state.

## Location and lifecycle

- **Path:** `<workspace>/NOTES.md` at the worktree root.
- **Created by the agent that starts the session** — the orchestrator on entry,
  or a standalone skill on entry.
- **Ownership transfers with execution.** The running agent always owns NOTES.md.
  The orchestrator owns it before and after work; the worker agent owns it during
  the work. Execution is sequential, so there is never a concurrent write conflict.
- **Updated by the currently running agent** after each completed task, significant
  decision, or before each further work unit (checkpoint).
- **Read on resume** — before re-reading the issue, reconstruct state from NOTES.md.
- **Harvested at phase end** — the orchestrator reads it and flows in-flight state
  (e.g. the AC checklist) into the phase handoff.
- **Left in place on exit** — worktree cleanup removes the file together with the
  worktree. Standalone skills leave it in place too.
- **On abnormal exit** — NOTES.md persists, preserving resume state for the next
  session; cleanup still happens with worktree removal.

## Required sections

NOTES.md is a bullet list, not prose. Keep it concise and information-dense —
re-reading it must cost under ~2k tokens.

```markdown
# NOTES — <task-slug>

## Current task
- <the one thing being worked on right now>

## Task list / AC checklist
- [x] <done AC or subtask>
- [ ] <pending AC or subtask — first unchecked item is current>
- [!] <blocked item — with reason>

## Subtask plan
- [ ] <subtask 1 — brief plan>
- [ ] <subtask 2 — brief plan>

## Decisions made this session
- <one-line decision> (why: <rationale>)
- ...

## Next action on resume
- <exact action to resume if the session dies — file to open, routine to call>
```

The task list covers both acceptance criteria (from the issue) and subtasks;
the first unchecked entry is the current one.

## Update cadence

Checkpoint at these points, bullet-level only:

- **On session start** — create NOTES.md with the AC checklist, the subtask plan,
  and the next action on resume.
- **Before and after significant work units** — before starting, write
  `## Current task` and `## Next action on resume`. If the session dies
  mid-work, this checkpoint is the sole resume source. After finishing, read
  NOTES.md, integrate the results, flip checkboxes for completed ACs and
  subtasks, log decisions with rationale, update `## Current task` and
  `## Next action on resume`.
- **After each significant decision** — one line with rationale.

Don't update for trivial moves (opening a file, running a test). Checkpoint log,
not transcript.

## Rules

- **Checkpoint before and after significant work units.** If the session dies
  mid-work, NOTES.md is the sole resume source.
- **Keep under ~2k tokens.** Summarize stable decisions if the file grows.
- **NOTES.md is authoritative for in-flight state.** Trust the file; in-context
  recall is rot-degraded.
- **The issue is authoritative for cross-phase state.** Acceptance criteria,
  locked decisions, and handoff state live in the issue, not in the file.
- **Ownership transfers with the running agent.** The orchestrator owns NOTES.md
  before and after work; the worker agent owns it during the work.
- **Deletion is worktree cleanup's responsibility.** On abnormal exit, NOTES.md
  preserves resume state; cleanup happens with worktree removal.

## Resume protocol

When NOTES.md exists in the workspace, treat it as a resume:

1. Read `<workspace>/NOTES.md` first.
2. Read the issue second (cross-phase decisions and acceptance criteria).
3. Resume from `## Next action on resume`, or from the first unchecked item in the
   task list if the next action is stale.
4. Update `## Current task` and `## Next action on resume` before the first real
   action.

## Standalone skill pattern

A standalone skill (invoked directly, not through the orchestrator) uses NOTES.md
as a lightweight progress tracker:

1. **Create** — on entry, create NOTES.md with `## Task list / AC checklist`,
   `## Subtask plan`, `## Decisions made this session`, and
   `## Next action on resume`.
2. **Update** — flip checkboxes as items complete, log decisions, update
   `## Current task` and `## Next action on resume` at each natural breakpoint.
3. **Leave** — on exit, leave NOTES.md in place. Do not delete.

The pattern is create → update → leave. Standalone skills do not drive an
orchestrator, so they have no checkpoint-before-work requirement.

## On exit

NOTES.md is temporary. On normal exit, leave it for worktree cleanup. On abnormal
exit, it persists for resume — the next session follows the resume protocol above.
