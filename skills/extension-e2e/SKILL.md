---
name: extension-e2e
description: Test agents-memo extension commands end-to-end in a real pi instance (isolated HOME, headless /command dispatch). Use before merging extension changes or when asked to test a command.
when_to_use: Run when the user asks to test the extension or a specific command (memo:init, memo:promote-global, ...), or before merging changes to extensions/agents-memo.ts.
model: sonnet
effort: low
user-invocable: false
allowed-tools: Bash Read
---
Test pi extension commands end-to-end with a REAL pi instance, without touching
the user's real config. Two patterns: a headless isolated-HOME runner (core
path) and a mocked-ui harness (interactive branches).

## Scripts

|Script|Purpose|
|-|-|
|`bin/e2e-command.sh "<command>" [--vault PATH\|--no-vault] [--keep]`|Run any registered command headless in a real pi with an isolated HOME|
|`bin/e2e-init.sh [--keep]`|Full /memo:init test: boots vault, asserts artifacts, checks no-vault path|
|`tests/extension-smoke.mjs`|Mocked-ui harness — verifies registration + interactive branches|

## Pattern 1 — isolated-HOME headless runner

`bin/e2e-command.sh "memo:init" --vault /tmp/scratch-vault` runs `pi -p
"/memo:init"` from a scratch project dir with a COPY of the real settings in a
scratch HOME. It rewrites `agentsMemo.vaultPath` (tier 0a wins over project
settings — a headless run would otherwise hit the REAL vault) and makes
relative package entries absolute (they resolve against the scratch settings
dir otherwise). Never touch `~/.pi/agent/settings.json`; the scratch HOME is
removed unless `--keep` / `E2E_KEEP=1`.

## Pattern 2 — mocked-ui harness

Headless pi has `ctx.hasUI=false`, so `ui.input/confirm/notify` branches are
skipped. Registration + interactive branches are covered by
`tests/extension-smoke.mjs` (mock pi with scripted ui). For a NEW command:
add a `section("name — command registration")` asserting
`mock.commands.find(c => c.name === "name")` and drive the handler with
scripted ui answers.

## pi internals (verified facts)

- `session.prompt()` dispatches "/"-prefixed input to `registerCommand`
  handlers immediately, before any LLM call — so `pi -p "/memo:init"` runs the
  handler with NO model invocation.
- Print mode requires a configured `model` at session start
  (`main.js: if (appMode !== "interactive" && !session.model) exit 1`) — the
  copied settings provides it; the command path never validates the API key.
- `getVaultPath` resolves tier 0a (`~/.pi/agent/settings.json`) before project
  settings — hence the isolated HOME.
- Slash dispatch matches the FIRST token only (`agent-session.js`): single-token
  names (`memo:init`) are dispatchable; `memo-wiki promote-global` (space) is not.
- The extension's session-start injection reads the scratch vault (missing
  hot.md → no-op); no interference with the command run.

## /memo:init verification checklist

- Exit 0 with configured vault; vault contains wiki/{concepts,entities,sources,questions,meta}, .raw, _templates, .obsidian, notes/, daily/, seeded files, .git, AGENTS.md with no `{{` placeholders and the plugin root path.
- Exit 0 with NO vault configured (graceful cancel, no crash).
- Re-run on the same vault is idempotent (exit 0).
- EXISTING vault: `.obsidian/*.json` configs preserved (first-run copy only;
  force re-sync with `AGENTS_MEMO_SYNC_OBSIDIAN=1`), pre-existing wiki pages
  preserved, AGENTS.md gained if missing.

All of the above are exercised by `bin/e2e-init.sh` (4 scenarios + artifact
assertions).

## Workflow

1. Rebuild the extension first: `npm run build` (commands load from dist/).
2. Run `bin/e2e-init.sh` for /memo:init; `bin/e2e-command.sh "<cmd>"` for others.
3. Run `node tests/extension-smoke.mjs` for registration + ui branches.
4. Report artifacts + exit codes; the TUI (interactive) path still needs a human
   restart to verify dialogs visually — headless covers the core logic.
