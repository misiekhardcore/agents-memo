# agents-memo

Agent + user instructions for the agents-memo package (pi extension + Claude Code plugin).

## Vault Assumptions

This vault is designed for **agent-only** use with **single-user, single-machine** access patterns. Any feature proposal violating one of these assumptions must be challenged before implementation:

- **Agent-only readers/writers.** No multi-user tiering, reviewer workflow, access control, or `reviewed_at` timestamps. Every write is an agent or the single human owner; human review happens via git, not via in-vault metadata.
- **Single-user, single-machine by default.** Cross-project access is opt-in per-project, not a multi-tenant design target.
- **Git-backed, file-per-page.** No database, no server, no live sync. All coordination is via commit history.

## Plugin Setup

1. Set `vaultPath` in pi settings (`~/.pi/agent/settings.json`) or `vault_path` in Claude Code settings — or the runtime auto-discovers a `wiki/` folder in CWD.
2. Run `/wiki init` to bootstrap vault structure.

## Vault Structure

```text
wiki/              Knowledge base (hot.md, index.md, concepts/, entities/, sources/)
notes/             Inbox: pending + deferred notes (notes/index.md)
daily/             Daily logs: YYYY-MM-DD.md with ## Captures bullets
.raw/              Immutable source documents + .manifest.json
_templates/        Obsidian Templater templates
_attachments/      Images and PDFs
```

## Wiki Conventions

- **Vault root:** `${vault_path}` (contains `wiki/` and `.raw/`)
- **Hot cache:** `wiki/hot.md` (~500 words, read at session start, written at session end)
- **Index:** `wiki/index.md` (master registry with categories)
- **Categories:** `wiki/concepts/`, `wiki/entities/`, `wiki/sources/`
- **Source documents:** `.raw/` (immutable; agents never modify)
- **Manifest:** `.raw/.manifest.json` (delta tracking for ingested sources)

## Vault I/O
All vault reads and writes go through **Obsidian CLI**, not `Read`/`Write`/`Edit`. Enforcement is active, not advisory: the pi extension gates every vault interaction.
- The `tool_call` handler rewrites bare `obsidian <verb> ...` calls through `scripts/obsidian-cli.sh` (vault resolution, preflight, exit-code normalization).
- The same handler **denies** direct file-tool calls on vault paths and returns the correct CLI verb in the deny reason, so the agent self-corrects on the next turn.
- **Technical Patterns**: See `${MEMO_PLUGIN_PWD}/skills/vault-ops/SKILL.md` for CLI patterns, slugging, indexing, active enforcement, and the canonical bypass list.

```bash
obsidian read path=wiki/hot.md
obsidian create path=wiki/concepts/foo.md content="..."
obsidian append file=wiki/log.md content="..."
obsidian prepend file=wiki/index.md content="..."
```
`Read` allowed only outside the vault (skill refs, external paths) or on the documented bypass paths in `${MEMO_PLUGIN_PWD}/skills/vault-ops/SKILL.md`. `Write`/`Edit` likewise restricted to the bypass paths; everything else is hook-denied.

## Skills Discovery

All skills live in `skills/<name>/SKILL.md` and are auto-discovered by Claude Code via the plugin manifest.

## Available Skills

|Skill|Trigger phrases|
|-|-|
|`wiki`|`/wiki`, set up wiki, scaffold vault, check setup|
|`ingest`|ingest, ingest this url, ingest this image, batch ingest|
|`query`|query, what do you know about, query quick:, query deep:|
|`lint`|lint the wiki, health check, find orphans, dead links|
|`save`|`/save`, file this conversation, save insight|
|`notes`|`/note`, `/dump`, note this, todo:, show my inbox, `/note process`|
|`daily`|`/daily`, daily note this, log to today, log this, add to today's log|
|`daily-close`|`/daily-close`, close today, wrap up today, synthesize today|
|`braindump`|`/braindump`, brain dump this, dump the following thoughts, dump these thoughts, braindump:, split this into notes|
|`autoresearch`|autoresearch, autonomous research loop|
|`canvas`|`/canvas`, add to canvas, create canvas|
|`defuddle`|clean this url, defuddle, strip clutter|
|`obsidian-markdown`|obsidian syntax, wikilink, callout, embed|
|`obsidian-bases`|obsidian bases, .base file, dynamic table|

## Bootstrap

1. On first invocation: read this file + `skills/wiki/SKILL.md`.
2. Hot cache auto-read: `bootstrap_read_hot` (default: `on-demand`):
   - `always`: injected at SessionStart; absorb silently.
   - `on-demand`: skills read when active (saves ~2–3k tokens for non-wiki sessions).
   - `never`: user preference, avoid loading unless explicitly requested.
3. On `/wiki` or "set up wiki": follow wiki skill scaffold workflow.

## Orchestration via Sub-Agents

Skills dispatch sub-agents to parallelize heavy lifting and avoid context bloat:

- **`ingest`** → `agents/memory-ingest.md` (one per source; writes wiki pages/index)
- **`braindump`** → `agents/memory-capture.md` (parallel when independent; sequential when order matters)
- **`lint`** → `agents/memory-lint.md` (runs all 16 checks; drafts report)
- **`autoresearch`** → `agents/memory-research-round.md` + `agents/memory-source-synth.md` (search/fetch/synthesis)
- **`query`** → `agents/memory-gather.md` (parallel page reads when list > 5 pages)

Orchestrators verify CWD before spawning: `cd "${VAULT_ROOT}" && pwd`. Agents write wiki state; orchestrators coalesce results and update cross-cutting state (index, log). **Parallel agents never update `wiki/hot.md`** — only the orchestrator does (see `${MEMO_PLUGIN_PWD}/skills/hot-cache-protocol/SKILL.md`).

## Ingest Rules

Single-source ingests require interactive discussion (what to emphasize, granularity, existing context to link). Escape: "just ingest it" or "auto-ingest". Exempt: `/autoresearch` (intentionally autonomous).

## CLI Setup
Vault I/O via **Obsidian CLI** (shipped with 1.12.7+). See `_shared/setup.md` for installation and registration.

## Documentation Standards

See `_shared/documentation-standards.md`. All skill and reference docs follow the content-dense, declarative structure defined there.

## Cross-Project Access

Add to other projects' `.pi/agent/settings.json`:
```markdown
## Wiki Knowledge Base
Path: /path/to/vault
When needed: (1) read wiki/hot.md first, (2) read wiki/index.md, (3) drill into domain pages.
Do NOT read for general coding questions.
```

# Agent Architecture

This directory (`agents/`) contains sub-agent definition files dispatched by orchestrator skills for parallelized or specialized work. Agents are loaded via the `memo_dispatch` tool (single, parallel, or chain mode).

## Agent Inventory

|File|Dispatched by|Purpose|
|-|-|-|
|`memory-capture.md`|`braindump` skill|Files one atomic chunk as an inbox note|
|`memory-gather.md`|`query` / `daily-close`|Reads files and returns structured summaries|
|`memory-ingest.md`|`ingest` skill|Processes one source into wiki pages|
|`memory-lint.md`|`lint` skill|Runs full wiki health check; produces report|
|`memory-search.md`|orchestrators / `Task`|Answers questions from vault content (read-only)|
|`memory-research-round.md`|`autoresearch`|Searches, fetches, dispatches source-synth agents|
|`memory-source-synth.md`|`research-round`|Synthesizes one source into wiki pages|

## Conventions

- **Frontmatter always includes**: `name`, `description`, `model`, `maxTurns`, `tools`, `disallowedTools`, `background`.
- **`disallowedTools`** must include `Agent` (agents never spawn sub-agents).
- **`background: true`** — agents run silently; orchestrator collects output.
- **`model`** — `haiku` for read-only/search tasks, `sonnet` for synthesis/writing.
- **CWD verification required** — every agent begins with `cd "${VAULT_ROOT}" && pwd`.
- **No cross-cutting state** — agents never update `wiki/hot.md`, `wiki/index.md`, or `wiki/log.md`. That is always the orchestrator's job.
- **Vault I/O** — all vault reads/writes via `obsidian <verb>` through `scripts/obsidian-cli.sh`.

## Reading Agent Files

Agent files are declarative single-responsibility specs. They follow this structure:

1. Frontmatter (configuration)
2. Role/constraint summary
3. CWD verification block
4. Inputs section
5. Process/pipeline description
6. Output format

Do not add procedural boilerplate. Reference `_shared/` files for shared protocols.
