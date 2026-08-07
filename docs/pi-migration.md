# Migration Plan: agents-memo → pi

Status: **Draft** — 2026-08-06 (decisions: memo-dispatch ✓, auto-reflection ✓)
Scope: Make agents-memo fully functional as a pi extension/package, replacing
the Claude Code plugin surface. Goal: agents-memo replaces `pi-self-learning`
as the memory/knowledge layer in pi.

## 1. Current state (what is Claude-Code-specific)

|Surface|File(s)|Claude Code mechanism|Status in pi|
|-|-|-|-|
|Event hooks|`hooks/hooks.json`|SessionStart / PostCompact / PreToolUse / PostToolUse / Stop / SessionEnd|**Dead** — pi has no hooks.json support|
|Plugin config|`scripts/resolve-vault.sh`, `scripts/resolve-config.sh`|`~/.claude/settings.json` → `pluginConfigs[*agents-memo*].options.*`|**Dead** — `~/.claude/` was deleted (Aug 2026 cleanup)|
|Plugin root var|37 files (uncommitted migration)|`${CLAUDE_PLUGIN_ROOT}` → `${MEMO_PLUGIN_PWD}`|**Broken** — neither var is set by pi's bash tool|
|Session bootstrap|hooks.json SessionStart|stdout injection of INIT.md / hot.md / index.md|**Dead**|
|CLI rewrite|`hooks/obsidian-cli-rewrite.sh`|PreToolUse Bash matcher, `updatedInput`|**Dead** — raw `obsidian` calls run unwrapped in pi|
|Vault I/O block|`hooks/block-direct-vault-io.sh`|PreToolUse Read\|Write\|Edit matcher, `permissionDecision: deny`|**Dead** — direct file tools on vault are unblocked|
|Hot-cache guard|`hooks/guard-hot-cache.sh`|PostToolUse Bash matcher|**Dead** (script itself is agent-agnostic)|
|Auto-commit|hooks.json PostToolUse Write\|Edit|git add + commit on vault file changes|**Dead**|
|Tool logging|`hooks/log-tool-use.sh`, `hooks/log-obsidian-calls.sh`|PostToolUse, scratch log for reflection|**Dead**|
|Stop reminder|hooks.json Stop|WIKI_CHANGED reminder|**Dead**|
|Session reflection|`hooks/session-reflection.sh`|`claude -p --model claude-haiku-4-5`|**Dead** — claude CLI deleted|
|Subagent specs|`agents/*.md` (7 files)|Claude Task-tool frontmatter (`model:`, `maxTurns:`, `permissions:`, `disallowedTools:`)|**Dead** — Claude-specific frontmatter|
|Cross-skill refs|`Skill("vault-ops")` etc. (9 files)|Claude skill expansion|**Dead** — pi does not expand `Skill()`|
|Slash commands|`.claude-plugin/plugin.json` (userConfig, commands)|`/wiki init` etc.|**Dead**|
|Marketplace manifest|`.claude-plugin/marketplace.json`, `plugin.json`|Claude plugin marketplace|N/A — deprecate|

**What already works in pi:**
- Skill **discovery** — all 20 skills are symlinked into `~/.pi/agent/skills/`
  and load correctly.
- `scripts/obsidian-cli.sh` and the obsidian CLI itself (1.13.4 on PATH,
  Obsidian running, vault at `~/Projects/llm-memory`).
- `scripts/slug.sh`, `index-section-insert.sh`, lint scripts — pure bash,
  agent-agnostic (only the path var breaks them).
- `hooks/guard-hot-cache.sh` — uses `BASH_SOURCE`-relative resolution, works
  standalone (regression suite passes).
- The `agents_memo/` symlink farm under `~/.pi/agent/skills/` (points at the
  plugin root; unused by pi but harmless).

**Confirmed breakage (verified this session):**
```bash
$ echo ${MEMO_PLUGIN_PWD:-UNSET}   # → UNSET
$ bash ${MEMO_PLUGIN_PWD}/scripts/slug.sh "test"  # → No such file or directory
```
Every skill command that references the var fails in pi. The save cycle in
this session only succeeded because steps were executed manually with the
absolute path.

## 2. Target architecture

A **pi package** (single git repo, installable via `pi install
git:github.com/misiekhardcore/agents-memo`) with:

```
agents-memo/
├── package.json          # + "pi": { "extensions": [...], "skills": [...] }
├── extensions/
│   └── agents-memo.ts    # NEW — replaces hooks.json 1:1
├── skills/               # keep; fix Skill() refs + path vars
├── scripts/              # keep; fix config resolution
├── agents/               # convert to pi-compatible personas
└── hooks/                # keep for Claude Code compatibility (optional)
```

## 3. Event mapping (hooks.json → pi events)

|Claude hook|pi event|Job|
|-|-|-|
|SessionStart (INIT.md)|`before_agent_start`|inject `_shared/INIT.md` as a message (customType, `display:false`)|
|SessionStart (hot.md)|`before_agent_start`|inject `wiki/hot.md` when `bootstrapReadHot = "always"`|
|SessionStart (index.md)|`before_agent_start`|inject `wiki/index.md` when `bootstrapReadIndex = "always"`|
|PostCompact (hot/index)|`session_compact`|re-inject hot.md / index.md|
|PreToolUse Bash|`tool_call` (`bash`)|(a) substitute `${MEMO_PLUGIN_PWD}` / `${CLAUDE_PLUGIN_ROOT}` with the resolved plugin root; (b) rewrite leading `obsidian` → `scripts/obsidian-cli.sh`; (c) daily-overwrite deny (#98) via `{ block: true, reason }`|
|PreToolUse Read/W/E|`tool_call` (`read`/`write`/`edit`)|block-direct-vault-io → `{ block: true, reason }` (reuse existing allowlist)|
|PostToolUse Bash|`tool_execution_end`|guard-hot-cache (reuse the bash script via `pi.exec`)|
|PostToolUse W/E|`tool_result`|log-tool-use scratch feed|
|—|`tool_execution_end` (bash)|log-obsidian-calls (`.obsidian-cli.log`)|
|—|`agent_settled`|**auto-commit**: `git add wiki/ .raw/ && commit` when vault git is dirty|
|Stop|`agent_settled`|WIKI_CHANGED reminder → `ctx.ui.notify`|
|SessionEnd|`session_shutdown`|session reflection → `complete()` from `@earendil-works/pi-ai` (NOT the deleted `claude` CLI)|
|`/wiki init` etc.|`pi.registerCommand`|port plugin.json commands|

**Why no bash-tool override:** env-var substitution and CLI rewriting both
happen in `tool_call` by mutating `event.input.command` (documented pi
behavior, same approach the Claude hook used with `updatedInput`). This avoids
reimplementing the built-in bash tool. Skills keep working unchanged — their
`${MEMO_PLUGIN_PWD}` references are rewritten before execution.

## 4. Config migration

Replace `~/.claude/settings.json` (`pluginConfigs[*agents-memo*].options`)
with a pi settings block. pi settings live at `~/.pi/agent/settings.json`
(global) merged with project `.pi/settings.json` (pattern proven by
`pi-self-learning` → `loadMergedSettings(ctx.cwd)`).

```jsonc
{
  "agentsMemo": {
    "vaultPath": "~/Projects/llm-memory",
    "bootstrapReadHot": "on-demand",     // always | on-demand | never
    "bootstrapReadIndex": "on-demand",   // always | on-demand | never
    "autoCommit": true
  }
}
```

- Extension reads config via settings merge; passes resolved values to
  injection and guard logic in-process.
- `scripts/resolve-vault.sh` / `resolve-config.sh` gain a new priority tier:
  `~/.pi/agent/settings.json` + `.pi/settings.json` (keep `$(pwd)/wiki`
  fallback, keep `~/.claude` tier for legacy Claude users). This keeps the
  bash scripts functional for skill-invoked commands that run outside the
  extension (e.g. cron lint).

## 5. Package plumbing

1. `package.json`: add
   ```jsonc
   "keywords": ["pi-package"],
   "pi": { "extensions": ["./extensions"], "skills": ["./skills"] }
   ```
2. Extension imports use the aliased scopes (both work at runtime):
   `@earendil-works/pi-coding-agent` or legacy `@mariozechner/*`.
3. Install: `pi install git:github.com/misiekhardcore/agents-memo` (or
   `~/.pi/agent/settings.json` → `"packages": ["git:..."]`).
4. Replace the per-skill symlinks in `~/.pi/agent/skills/` with the packaged
   skill set (pi loads `skills/` from the package manifest). Remove the
   `agents_memo/` symlink farm.
5. Commit the pending 37-file `CLAUDE_PLUGIN_ROOT` → `MEMO_PLUGIN_PWD`
   migration as part of this work — it becomes meaningful once the extension
   injects the var via command rewriting.

## 6. Skill text fixes (small, mechanical)

- `Skill("vault-ops")` and similar (9 files): replace with an explicit
  instruction + path, e.g. `Read <plugin>/skills/vault-ops/SKILL.md first`
  (pi loads skills via the `read` tool; no `Skill()` expansion exists).
- Keep `${MEMO_PLUGIN_PWD}` references — the extension substitutes them at
  `tool_call` time. No skill rewrite needed for the var itself.
- `_shared/INIT.md` `Skill("vault-ops")` reference: same replacement.

## 7. Sub-agent dispatch: memo-dispatch tool (DECIDED: yes)

**The existing version DID spawn sub-agents.** Verified in `CLAUDE.md` §Agent
Architecture: agents are dispatched via Claude Code's `Agent()` / `Task()`
tool for parallelized or specialized work, with frontmatter (`name`,
`description`, `model`, `maxTurns`, `permissions`, `disallowedTools`,
`background`). The skills fan out deliberately:

- `ingest` → one `agents/ingest.md` per source, parallel
- `autoresearch` → one `source-synth.md` per source, then one `research-round.md` per gap
- `query` / `daily-close` → one `gather.md` per cluster (parallel)
- `braindump` → one `capture.md` per chunk (parallel)

Pi ships a reference implementation that does exactly this:
`examples/extensions/subagent/` (single / parallel / chain modes, spawns an
isolated `pi --mode json -p --no-session` subprocess per task with
`--model`, `--tools`, `--append-system-prompt`, streaming output, usage
tracking, abort propagation). **The memo-dispatch tool will be built on this
example** (copy + adapt, keep the MIT license attribution).

### Adaptations needed

1. **Agent discovery**: the example reads `~/.pi/agent/agents/*.md` and
   `.pi/agents/*.md`. agents-memo specs live in the repo `agents/` dir —
   the tool must also load from `<plugin>/agents/`. Frontmatter keys match
   (`name`, `description`, `model`, `tools`).
2. **Frontmatter conversion** (Claude format → pi format):
   - `permissions: bash: allow` + `disallowedTools: Agent Write Edit …` →
     `tools: bash, read, grep, find, ls` allowlist (pi has no denylist).
     `Agent` must be dropped (pi subagents never nest via this tool anyway).
   - `model: haiku | sonnet` → real pi model IDs. **No Claude models are
     available in pi** (11 models: deepseek/deepinfra/ollama). Proposed
     mapping, configurable per-agent or in settings:
     `haiku → deepseek-v4-flash` (fast/cheap, read-only tasks),
     `sonnet → deepseek-v4-pro` (synthesis/writing).
   - `maxTurns` — **pi has no max-turns support** (no CLI flag, no SDK
     option in headless mode). Drop for phase 1; note as a pi limitation.
     Task scoping in the system prompt compensates.
   - `background: true` → the example's collapsed-view rendering already
     keeps sub-agent noise minimal; no separate flag needed.
3. **Naming mismatch (latent bug)**: skills and `CLAUDE.md` reference
   `agents/ingest.md`, `agents/gather.md`, `agents/capture.md`, etc., but
   the files were renamed to `memory-*.md` in June (commit `7719315`). The
   frontmatter `name:` fields are `memory-*`. Fix the skill references to
   the actual names during this migration (they would silently fail with
   "Unknown agent" in the dispatch tool).
4. **Invocation from skills**: skills keep saying "dispatch `agents/ingest.md`
   per source (parallel)" — now meaning the `memo-dispatch` tool with
   `{ tasks: [{ agent: "memory-ingest", task: "..." }, ...] }`.

## 8. Replacing pi-self-learning (endgame)

Once agents-memo runs in pi:

1. Disable pi-self-learning: remove `npm:pi-self-learning` from
   `~/.pi/agent/settings.json` `packages` (or `selfLearning.enabled: false`).
2. Coverage comparison:
   |pi-self-learning|agents-memo replacement|
   |-|-|
   |auto reflection after each task (`agent_end`)|**DECIDED: yes** — add `agent_end` reflection into `daily/YYYY-MM-DD.md` (phase 2, implemented in the extension via `complete()`)|
   |daily logs `daily/*.md`|vault `daily/` notes (same shape)|
   |monthly summaries|vault `wiki/log.md` + daily-close skill|
   |core learnings + ranking|`wiki/hot.md` + save/lint skills (different philosophy — wiki pages over scored bullets)|
   |git-backed memory repo|vault git auto-commit|
   |context injection per turn|hot.md/index.md bootstrap injection|
3. **Auto-reflection design (decided)**: on `agent_end`, if the session
   touched the vault, call `complete()` with the session model (pattern from
   pi-self-learning: `getModel` + `resolveModelRequestAuth` via
   `ctx.modelRegistry`) to distill 3-5 learnings, append to
   `daily/YYYY-MM-DD.md` under a `### Session HH:MM` heading. Deduplicate
   against the session-scratch log (already fed by log-tool-use) and skip
   when no vault activity occurred. Configurable via `agentsMemo.reflectOnEnd:
   true` (default) / `false`.
4. Optionally keep the `session_shutdown` reflection for the end-of-session
   summary; `agent_end` covers the per-task behavior. Both write to the same
   daily file.

## 9. Work breakdown (suggested order)

1. **Config**: extend `resolve-vault.sh` / `resolve-config.sh` with pi
   settings tier; add `agentsMemo` block to `~/.pi/agent/settings.json`.
2. **Extension scaffold**: `extensions/agents-memo.ts` with settings merge +
   `tool_call` rewrite (var substitution + obsidian wrapper + daily guard).
   Manual test: skill commands with `${MEMO_PLUGIN_PWD}` start working.
3. **Injection**: `before_agent_start` INIT.md + hot.md/index.md
   (bootstrap_read_* honored); `session_compact` re-injection.
4. **Guards**: `tool_call` read/write/edit vault block; `tool_execution_end`
   hot-cache guard; `agent_settled` auto-commit + WIKI_CHANGED notify.
5. **Reflection**: `agent_end` auto-reflection into daily notes (decided) +
   `session_shutdown` summary; port scratch-log feed (`tool_result` /
   `tool_execution_end`).
6. **memo-dispatch tool**: adapt `examples/extensions/subagent/` (parallel
   modes, agent discovery incl. `<plugin>/agents/`, frontmatter conversion,
   model mapping table).
7. **Skill text**: replace `Skill()` refs (9 files); fix stale
   `agents/*.md` names → `memory-*.md` in skill dispatch instructions;
   document `memo-dispatch` invocation.
8. **Packaging**: pi manifest, install via git package, remove symlinks.
9. **Commit the 37-file var migration** (now meaningful).
10. **Tests**: extend `Makefile test` with a pi-event regression harness
    (unit-test the rewrite/injection functions by importing the extension
    module; keep existing bash regression suites).

## 10. Open questions

- Keep Claude Code compatibility (hooks.json + marketplace) or drop it?
  (Recommend: keep the bash scripts, drop hooks.json once the extension
  lands; `.claude-plugin/` can be removed or marked deprecated.)
- `maxTurns` frontmatter: drop it (pi has no support) or implement a
  best-effort timeout per task in memo-dispatch?
- `autoCommit` default: on (matches current PostToolUse behavior) or off?
- Reflection dedup: how chatty should `agent_end` reflection be — every
  task, or only when the vault was touched?
