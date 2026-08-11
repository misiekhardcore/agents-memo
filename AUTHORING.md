# Authoring Guide

## Directory Layout

```text
_shared/          Cross-skill reference docs
scripts/          Utility scripts (obsidian-cli.sh, resolve-vault.sh)
skills/<name>/    One skill per dir (SKILL.md entrypoint + references/)
agents/           Sub-agent definitions
_templates/       Templater templates + authoring guidance
```

## Plugin File Model

Plugins consist of three file types. Organize by concern, load on-demand, promote reusable content to `_shared/`.

### Three-Tier Architecture

|File Type|Location|Role|Loaded when|
|-|-|-|-|
|**Entry point**|`SKILL.md`|Thin orchestrator. Describes I/O, routes to references. ≤150 lines.|Skill invoked|
|**Reference module**|`skills/<name>/references/<concern>.md`|Owns one phase or topic. Heavy content (schemas, tables, detailed logic).|Point of need: when the phase becomes active|
|**Shared library**|`_shared/<concern>.md`|Cross-skill protocol or reusable concern. Promote when ≥3 skills need it.|Point of need; when first skill activates that concern|

### Principles

**Single responsibility:** One file per concern (phase, schema, topic, workflow stage). A file covering two concerns is two files.

**Lazy loading:** Never preload `_shared/` or reference files at skill start. Place every `Read` instruction at the step that activates the concern. Preloading burns tokens on every invocation regardless of code path.

**DRY promotion:** When content repeats across ≥3 skills, extract to `_shared/`. Otherwise keep under `skills/<name>/references/`.

**Composition:** `SKILL.md` describes what to do and cites where detail lives; it does not contain the detail.

### Split Heuristic

Extract to a reference file when content exceeds ~10 lines AND is stable, or the same block repeats in ≥2 steps. Promote to `_shared/` when ≥3 skills need the same concern.

A file growing past ~60 lines is a signal to audit for natural phase/topic boundaries — not a mandate to split.

Split at **natural gates**: user approval, scope branch, condition. Content always needed together = one file; content gated by a condition = separate file. Sequential steps that always run in order stay together.

### Naming

Name files after the phase or topic they own: `detection.md`, `scope.md`, `gates.md`, `schemas.md`, `syntax-tables.md`. Avoid generic names (`process.md`, `config.md`, `rules.md`) unless the file genuinely has no sub-topics.

### Entry-Point Cap

`SKILL.md` stays ≤150 lines. Extract stable reference material (schemas, tables, phase logic) into `skills/<name>/references/<concern>.md` and add a one-line `Read` instruction at the relevant step. Reference files have no line limit; single-concern discipline keeps them bounded.

### On-Demand Loading

Place `Read` at the step that activates the concern — never at the top:

```
Read ${MEMO_PLUGIN_PWD}/_shared/<file>.md
Read ${MEMO_PLUGIN_PWD}/skills/<name>/references/<concern>.md
```

**Phase-gated:** Read after the decision branch that activates the phase.
**Conditional:** Read only in the code path where the concern applies.

**In-repo exemplar** — `lint/SKILL.md` reads reference files at two distinct execution points:
- `references/checks.md` — read inline within each check step (heavy check logic, not preloaded)
- `references/dashboard.md` and `references/canvas-map.md` — read only in the output step when generating Bases and canvas artifacts

## Vault Operations: CLI Wrapper

All vault I/O via `scripts/obsidian-cli.sh`:

```bash
"${MEMO_PLUGIN_PWD}/scripts/obsidian-cli.sh" read path=wiki/hot.md
"${MEMO_PLUGIN_PWD}/scripts/obsidian-cli.sh" create path=wiki/concepts/foo.md content="..."
"${MEMO_PLUGIN_PWD}/scripts/obsidian-cli.sh" append path=wiki/index.md content="- New entry"
```

The pi extension transparently rewrites raw `obsidian <verb> ...` calls. For error handling, exit codes, and escape hatches, see `_shared/cli.md`.

## Skill & Command Frontmatter

|Field|Notes|
|-|-|
|`name`|Required. Must match the directory name for skills.|
|`description`|**≤150 chars.** Shown in `/` menu and used for harness routing.|
|`when_to_use`|Optional routing hint alongside `description`. Combined ≤1,536 chars. Include only when mis-routing is plausible: exclusions ("Does NOT X — use /Y"), preconditions, or disambiguation. Omit when `description` is unambiguous.|
|`allowed-tools`|Space-separated allowlist active while skill is running. Skills that dispatch sub-agents **must include `Agent`**. Vault ops go through `obsidian` CLI (Bash) — do not list `Read`, `Write`, `Glob`, or `Grep` unless the skill calls those tools directly outside the vault.|
|`effort`|`low`\|`medium`\|`high`\|`xhigh`\|`max` — effort level override.|
|`argument-hint`|Shown in autocomplete (e.g. `[topic]`). Add to any command that takes an argument.|
|`context`|Accepted value: `fork`. Runs the skill in an isolated subagent instead of inline.|
|`agent`|Used with `context: fork`. Names the agent type to dispatch (e.g., `agents-memo:ingest`).|
|`model`|`sonnet`, `opus`, `haiku`, or full model ID.|
|`user-invocable`|`false` hides skill from `/` menu (orchestrator-only skills).|

## Cross-plugin scope boundary

Skills in this repo operate on **vault contents only**: `wiki/`, `notes/`, `daily/`, `.raw/`, `wiki/meta/`.

**Out-of-scope here** — plugin-authoring audits (SKILL.md quality, AUTHORING.md accuracy, `_shared/` content) belong in the **`agents-flow:/prune` Authoring Lane** (`misiekhardcore/agents-flow:skills/prune/SKILL.md`).

**Sibling convention**: `misiekhardcore/agents-flow:_templates/AUTHORING.md` is the parallel authoring guide for that plugin.

**Worked example — "audit SKILL.md content":**

|Direction|Action|
|-|-|
|**Do**|Run `/prune` in `agents-flow` — the Authoring Lane audits skill files.|
|**Don't**|Open a `wiki-lint` issue in `agents-memo` — vault skills do not inspect skill source files.|

## Agent Frontmatter

Agents use **`tools`** (allowlist), not `allowed-tools` — using the wrong key is a **silent no-op**.

|Field|Notes|
|-|-|
|`tools`|Space-separated allowlist.|
|`disallowedTools`|Space-separated denylist. Defense-in-depth beyond the `tools` allowlist.|
|`maxTurns`|Max agentic turns.|
|`model`|Same aliases as skills.|

**Plugin security restrictions:** `permissionMode`, `hooks`, and `mcpServers` are **silently ignored** for plugin agents — do not set them.

## Sub-Agents vs. Inline

**Inline:** single item, order matters, fits in orchestrator.
**Sub-agents:** multiple independent items, parallelizable, avoids context bloat.

**Orchestrator:** verify CWD (`cd "${VAULT_ROOT}" && pwd`), collect reports, update index/log/hot.md once (never per-agent), never write vault state in parallel.

See agents/ for patterns: `capture` (single note), `ingest` (single source), `lint` (vault scan), `gather` (page cluster).

## Writing Style

- **Imperative**: "Read issue", not "You should read".
- **Dense**: No filler, no preamble.
- **Numbered workflows**: Step-by-step processes outperform prose.
- **Decision tables**: Resolve routing ambiguity before coding.
- **Paired prohibitions**: Every "Don't" must have a matching "Do".
- **150-line cap on `SKILL.md`**: Extract stable reference material into `_shared/` or `skills/<name>/references/` when the entry point exceeds 150 lines. Reference files have no line limit.
