# Agent Fan-out (Parallel)

## CWD verification

```bash
cd "${VAULT_ROOT}" && pwd
```

## Dispatch

Dispatch one `agents/memory-capture.md` per independent chunk. Pass each agent:
- `CHUNK` — the verbatim chunk text
- `VAULT_ROOT` — `$VAULT_ROOT`
- `SOURCE_PROJECT` — `basename(cwd)`
- `TODAY` — ISO date `YYYY-MM-DD`

## Constraints

- Parallel agents cannot MATCH-append to each other's notes (concurrent). If two chunks would MATCH the same note, run them inline in order instead.
- Agents do not patch the index — the orchestrator owns that write.

## Collect and patch index

Wait for all agents to complete. Collect `Filed:` / `Appended:` / `Error:` lines. Apply a single consolidated `notes/index.md` patch. For each `Filed:` line, prepend one checkbox row under `## Pending`:

```text
- [ ] YYYY-MM-DD [<source_project>] <title>
```
