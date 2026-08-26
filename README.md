# agents-memo

pi extension — personal knowledge vault with LLM-assisted ingestion, research, and retrieval. Built on Obsidian.

## Install

**Prerequisites:** Obsidian 1.12.7+ with the CLI binary on your `PATH`.

```bash
pi install npm:agents-memo
```

Configure vault path in `~/.pi/agent/settings.json`:

```json
{
  "agentsMemo": {
    "vaultPath": "/absolute/path/to/vault"
  }
}
```

Or set it in `.pi/settings.json` for per-project overrides.

Register the vault with Obsidian:

```bash
obsidian register vault=/absolute/path/to/vault
obsidian list vaults
```

See `_shared/setup.md` for troubleshooting and Flatpak setup.

## Configuration

All options live in the `agentsMemo` block of `~/.pi/agent/settings.json`
(global) or `.pi/settings.json` (per-project). Global values win per key;
project values only fill keys the global file leaves unset.

|Key|Type|Default|Description|
|-|-|-|-|
|`vaultPath`|string|auto-discovered `wiki/` in CWD|Absolute path to the vault|
|`bootstrapReadHot`|`"always"` \|`"on-demand"` \|`"never"`|`"on-demand"`|When the hot cache is injected at session start|
|`bootstrapReadIndex`|`"always"` \|`"on-demand"` \|`"never"`|`"on-demand"`|When the index is injected at session start|
|`autoCommit`|boolean|`true`|Auto-commit vault git changes when the agent settles|
|`autoPush`|boolean|`false`|After auto-commit, push the vault repo to its remote. Never force-pushes or retries - a failed push (remote moved) leaves the commit local and shows a warning|

autoPush requires the vault repo to have a remote and the current branch to have an upstream (run `git push --set-upstream origin <branch>` once).

## Skills

- `memo-wiki` — bootstrap / health-check the vault
- `memo-ingest` — parallel batch ingestion of sources
- `memo-query` — answer questions from vault content
- `memo-lint` — find orphan pages, dead links, stale claims
- `memo-save` — save the current conversation or insight into the vault
- `memo-notes` — quick inbox capture (`/memo-note`, `/memo-dump`); list and process flows for triage
- `memo-daily` — append-only chronological log (`/memo-daily`); timestamped bullets in `daily/YYYY-MM-DD.md`
- `memo-daily-close` — end-of-day synthesis (`/memo-daily-close`, "close today", "wrap up today"); appends a polished `## Summary` to today's daily file, idempotent on re-run
- `memo-braindump` — split long-form text into atomic notes (`/memo-braindump`, "brain dump this", "split this into notes"); each chunk filed via the full capture pipeline
- `memo-autoresearch` — autonomous iterative research loop
- `memo-canvas` — create / update Obsidian canvas files
- `memo-defuddle` — strip clutter from web pages before ingestion
- `memo-obsidian-markdown` — correct Obsidian-flavored Markdown (wikilinks, embeds, callouts)
- `memo-obsidian-bases` — create / edit `.base` files

## Vault structure

```text
<vault_path>/
  wiki/          agent-generated knowledge (hot.md, index.md, concepts/, entities/, sources/)
  notes/         inbox: verbatim quick-capture notes (owned by `memo-notes` skill)
  daily/         chronological daily log — one file per day (owned by `memo-daily` skill)
  .raw/          immutable source documents + .manifest.json
  _templates/    Obsidian Templater templates
  _attachments/  images + PDFs referenced by wiki pages
  .obsidian/     (user-owned) Obsidian app config
```

## Why Markdown, not a vector database?

agents-memo stores memories as plain Markdown files in an Obsidian vault and
retrieves them with grep. No embeddings, no vector index, no API costs.

||Markdown + grep|Vector DB|
|-|-|-|
|Cost|$0 - no embedding API, no storage|Embedding API + index hosting|
|Speed|grep over a personal vault is milliseconds|Fast, but adds an embedding step|
|Determinism|Same query, same result, every time|Approximate - results drift with model updates|
|Editability|Every memory is a file you can open, edit, link|Opaque chunks, hard to correct|

The unique wins: paginated `grep` + `read-tail` reads keep LLM context small
(no context explosion), retrieval is zero-cost and fully transparent, changes
are auto-committed to git, and the whole knowledge graph
is human-editable.

## Real-world example

1. **Ingest** - during a project, run `/memo-ingest <api-spec-url>` (or `obsidian
   create path=wiki/sources/...`). The memo-ingest skill extracts entities and
   concepts into `wiki/concepts/` and `wiki/entities/` and cross-references
   them.
2. **Query** - days or weeks later, ask `/memo-query` "what does the API return
   for auth failures?". The memo-query skill searches wiki pages and synthesizes
   an answer with citations.
3. **Save** - `/memo-save` files the conversation or insight back into the vault.
4. **Commit** - every write is auto-committed to git, so the vault is a
   versioned, searchable memory that grows with each session.

## Extension

Registers lifecycle handlers and tools for pi sessions:

- **Session start / compact** — injects `_shared/INIT.md`, hot cache, index, and project memory digest
- **Tool call** — rewrites `obsidian` calls through `scripts/obsidian-cli.sh`, blocks direct vault I/O, guards daily overwrites
- **Tool execution end** — guards `wiki/hot.md` against 0-byte corruption
- **Agent settled** — auto-commits vault git changes
- **Agent end** — distills the run into project + global core learnings (reflection)
- **Session shutdown** — cross-project promotion sweep into `wiki/global-core.md`

Also registers the `memo_dispatch` tool for delegating work to vault sub-agents (single, parallel, chain modes).

### Commands

- `/memo:init` — initialize a vault: bootstrap (`wiki-init.sh`), `git init`,
  write the vault `AGENTS.md`, and offer the weekly lint cron
  (`bin/install-lint-cron.sh`) plus a Wiki Knowledge Base pointer in the CWD
  project's `AGENTS.md`.
- `/memo:promote-global` — deterministic cross-project promotion sweep into
  `wiki/global-core.md` (on-demand counterpart of the session-shutdown trigger).
- `/memo:compact-core` — merge near-duplicate bullets in the project core.

All three are single-token names, so they are slash-dispatchable in the TUI.

## Scheduled Maintenance

Lint is **opt-in via OS scheduler** (cron, systemd timers, launchd).
`bin/wiki-lint-cron.sh` runs the memo-lint skill via `pi -p` (headless) with
auto-fix and commit. Install the weekly entry with:

```bash
bin/install-lint-cron.sh              # weekly, Sun 03:00
bin/install-lint-cron.sh --uninstall  # remove it
bin/install-lint-cron.sh --schedule "0 2 * * 1"  # custom schedule
```

Requires Obsidian running and the agents-memo package registered in pi.

## Contributing

**Prerequisites:** Node.js ≥ 22 and npm.

```bash
npm install          # Install dependencies + husky pre-commit hook
npm run build        # Compile extensions (tsup)
npm run check        # Full validation: lint + format + typecheck + test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide (validation gates, pre-commit hook, PR process).

## More

- Repository: <https://github.com/misiekhardcore/agents-memo>
- Agent-facing docs (skills, vault structure, ingest rules): [`AGENTS.md`](AGENTS.md)
