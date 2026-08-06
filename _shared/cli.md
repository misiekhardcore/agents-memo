# CLI Contract

**Scope.** Authoritative reference for the Obsidian CLI mechanics: invocation, full verb table with output formats, exit codes, `content=` escape rules, canvas handling, and the re-spike procedure. All behaviors verified by `scripts/cli-spike.sh` (results in `tests/spike-results/`).

For skill-author operational patterns (when/why to call each verb, slugging, indexing, hot-cache protocol, active enforcement, canonical bypass list) Read `${MEMO_PLUGIN_PWD}/skills/vault-ops/SKILL.md` first, then follow its instructions.

Read on demand.

## 1. Invocation contract

All vault operations through `scripts/obsidian-cli.sh` (PreToolUse hook rewrites bare `obsidian` calls transparently).

```bash
"${MEMO_PLUGIN_PWD}/scripts/obsidian-cli.sh" read path=wiki/hot.md
```

**vault= is name-only** (basename, not path). Wrapper derives it automatically.

**Obsidian must be running.** CLI is desktop IPC; SessionStart hook probes connectivity.

**All output to stdout** (including errors). Wrapper normalizes exit codes.

## 2. Exit codes

See `${MEMO_PLUGIN_PWD}/_shared/cli-reference.md` for full exit-code table and escape hatches.

## 3. Verb reference

The upstream CLI always exits 0; the wrapper normalizes exit codes per §2.

### 3.1 Verb table (grouped by category)

#### Content read/write

|Verb|Args|Output|Notes|
|-|-|-|-|
|`read`|`file=` / `path=`|plain text|Full file content|
|`read-head`|`path=`, [`lines=N`]|first N lines|Wrapper-only. First N lines of a file (default 20). See §3.2.|
|`read-tail`|`path=`, [`lines=N`]|last N lines|Wrapper-only. Last N lines of a file (default 20). See §3.2.|
|`create`|`path=`, `content=`, [`template=`, `overwrite`, `open`, `newtab`]|`Created: <path>`|`overwrite` flag (no `=`) for full replacement|
|`append`|`file=` / `path=`, `content=`, [`inline`]|`Appended to: <path>`|`inline` omits trailing newline|
|`prepend`|`file=` / `path=`, `content=`, [`inline`]|`Prepended to: <path>`|`inline` omits trailing newline|
|`create-or-append`|`file=`, `template=`, `content=`|`Created and appended: <path>` / `Appended to: <path>`|Wrapper-only. Atomic create-or-append for daily/*.md (issue #98 race guard). See §3.3.|
|`delete`|`file=` / `path=`, [`permanent`]|confirmation text|`permanent` skips trash|
|`move`|`file=` / `path=`, `to=`|confirmation text|Destination folder or path|
|`rename`|`file=` / `path=`, `name=`|confirmation text|New filename only|

#### Frontmatter

|Verb|Args|Output|Notes|
|-|-|-|-|
|`property:read`|`name=`, `file=` / `path=`|plain text (single value)|Read one property|
|`property:set`|`name=`, `value=`, `file=` / `path=`, [`type=`]|plain text|`type=text\|list\|number\|checkbox\|date\|datetime`|
|`property:remove`|`name=`, `file=` / `path=`|plain text||
|`properties`|`file=` / `path=`, [`name=`, `total`, `sort=count`, `counts`, `format=`]|plain text (yaml default)|`format=yaml\|json\|tsv`|

#### Cross-reference (links)

|Verb|Args|Output|Notes|
|-|-|-|-|
|`backlinks`|`file=` / `path=`, [`counts`, `total`, `format=`]|`[{"file": "<path>"}]`|`format=json\|tsv\|csv` (default tsv)|
|`links`|`file=` / `path=`, [`total`]|plain text (wikilinks)|Outgoing links from a file|
|`unresolved`|[`counts`, `total`, `verbose`, `format=`]|`[{"link": "..."}]`|`format=json\|tsv\|csv` (default tsv)|
|`orphans`|[`total`, `all`]|plain text (one path/line)|Files with no incoming links|
|`deadends`|[`total`, `all`]|plain text (one path/line)|Files with no outgoing links|

#### Search & discovery

|Verb|Args|Output|Notes|
|-|-|-|-|
|`search`|`query=`, [`path=`, `limit=`, `total`, `case`, `format=`]|json|`format=text\|json` (default text). Full-text search across vault.|
|`search:context`|`query=`, [`path=`, `limit=`, `case`, `format=`]|plain text|Search with matching line context|
|`grep`|`path=`, `pattern=`, [`context=N`, `ignore-case=true`]|matching lines|Wrapper-only. Search within a single file via `obsidian read \|grep`. See §3.2.|
|`grep-files`|`pattern=`, [`dir=`, `context=N`, `ignore-case=true`]|matching lines with paths|Wrapper-only. Cross-file grep on filesystem (read-only). See §3.2.|
|`outline`|`file=` / `path=`, [`total`, `format=`]|plain text|`format=tree\|md\|json` (default tree). Headings as tree/md/json.|
|`tags`|`file=` / `path=`, [`total`, `counts`, `sort=count`, `format=`, `active`]|plain text|`format=json\|tsv\|csv` (default tsv)|
|`tag`|`name=`, [`total`, `verbose`]|plain text|Tag info + occurrence count|

#### File & folder listing

|Verb|Args|Output|Notes|
|-|-|-|-|
|`files`|[`folder=`, `ext=`, `total`]|plain text (one path/line)|List vault files. Already mentioned in §6 for canvas listing.|
|`folders`|[`folder=`, `total`]|plain text (one path/line)|List vault folders|
|`file`|`file=` / `path=`|plain text (info block)|Created/modified timestamps, size, etc.|
|`folder`|`path=`, [`info=files\|folders\|size`]|plain text|Folder stats. `info=` returns only that field.|

#### Daily notes

|Verb|Args|Output|Notes|
|-|-|-|-|
|`daily:path`|—|plain text (path string)|Get today's daily note path|
|`daily:read`|—|plain text|Read today's daily note content|
|`daily:append`|`content=`, [`inline`, `open`, `paneType=`]|`Appended to: <path>`|Append to daily note|
|`daily:prepend`|`content=`, [`inline`, `open`, `paneType=`]|`Prepended to: <path>`|Prepend to daily note|

#### Vault info & navigation

|Verb|Args|Output|Notes|
|-|-|-|-|
|`vault`|[`info=name\|path\|files\|folders\|size`]|plain text|Vault-level stats. `info=` returns only that field.|
|`vaults`|[`total`, `verbose`]|plain text|List known vaults|
|`version`|—|plain text|Obsidian version string|
|`aliases`|`file=` / `path=`, [`total`, `verbose`, `active`]|plain text|File aliases|
|`recents`|[`total`]|plain text (one path/line)|Recently opened files|
|`wordcount`|`file=` / `path=`, [`words`, `characters`]|plain text (number)|Word/char count|

#### Task management

|Verb|Args|Output|Notes|
|-|-|-|-|
|`tasks`|`file=` / `path=`, [`total`, `done`, `todo`, `status=`, `verbose`, `format=`, `active`, `daily`]|plain text|`format=json\|tsv\|csv` (default text)|
|`task`|`ref=`, `file=` / `path=`, `line=`, [`toggle`, `done`, `todo`, `status=`]|plain text|Show/update a specific task by ref or line. `daily` flag for daily note.|

#### Plugin & extension

|Verb|Args|Output|Notes|
|-|-|-|-|
|`plugins`|[`filter=core\|community`, `versions`, `format=`]|plain text|`format=json\|tsv\|csv` (default tsv)|
|`plugins:enabled`|[`filter=core\|community`]|plain text||
|`plugin`|`id=`|plain text|Plugin info|
|`plugin:enable`|`id=`, [`filter=`]|plain text||
|`plugin:disable`|`id=`, [`filter=`]|plain text||
|`templates`|[`total`]|plain text|List templates|
|`template:read`|`name=`, [`resolve`, `title=`]|plain text|Template content, optionally with variables resolved|
|`bookmarks`|[`total`, `verbose`, `format=`]|plain text|`format=json\|tsv\|csv` (default tsv)|
|`bookmark`|`file=` / `folder=` / `search=` / `url=`, [`subpath=`, `title=`]|confirmation text|Add a bookmark|

#### Maintenance & admin

|Verb|Args|Output|Notes|
|-|-|-|-|
|`commands`|[`filter=`]|plain text|List available command IDs|
|`command`|`id=`|depends on command|Execute command by ID (escape hatch #1)|
|`eval`|`code=`|JS return value|Execute JavaScript (escape hatch #2 — last resort)|
|`reload`|—|no output|Reload the vault|
|`hotkeys`|[`total`, `verbose`, `format=`, `all`]|plain text|`format=json\|tsv\|csv` (default tsv)|
|`diff`|`file=` / `path=`, [`from=`, `to=`, `filter=local\|sync`]|plain text|Diff local/sync versions|
|`history`|`file=` / `path=`|plain text|List file history versions|
|`history:read`|`file=` / `path=`, `version=`|plain text|Read a specific history version|
|`history:restore`|`file=` / `path=`, `version=`|confirmation text|Restore a history version|
|`sync:status`|—|plain text|Show sync status|

#### Canvas

|Verb|Args|Output|Notes|
|-|-|-|-|
|`files`|`dir=<path>`, `ext=`, `format=json`|`[{"path": "..."}]`|List .canvas files (see §6).|
|`read-canvas`|`path=`|structured plain text|Wrapper-only. Reads .canvas as structured text (groups as ##, edges resolved). See §6.|

**Multiline `content=`:** `\n` and `\t` round-trip correctly. Use `\n` for newlines.

**`content=` escape asymmetry:** `\\` does NOT produce literal backslash — every `\n` becomes newline regardless. For canvas JSON or code blocks with literal backslashes, use `eval` escape hatch:

```bash
obsidian eval code="await app.vault.adapter.write('path/to/file', '<full content>');"
```

### 3.2 Context-saving read strategies

These verbs return partial file content to save LLM context without sacrificing access to vault information. Some are wrapper-only (synthesized by `obsidian-cli.sh`), others are native CLI verbs deployed strategically.

**Decision tree for reading a file:**
1. Need just the structure? → `outline` (cheapest: only headings)
2. Need frontmatter + intro? → `read-head` (default 20 lines)
3. Need specific content? → `grep` (matching lines only)
4. Need the latest entries? → `read-tail` (last N lines, for log/daily files)
5. Need the full file? → `read` (most expensive — full content)

#### `outline` (native CLI)

Returns the heading tree of a file — a table of contents without any body text. ~5-15 lines for most wiki pages vs 94 avg for a full read. Supports multiple output formats. This is the **cheapest way to understand a file's structure**.

```bash
# Default tree format — hierarchical, easy to scan
obsidian outline path=wiki/concepts/orchestration-control-loop.md
# → ## Overview
# → ## Architecture
# → ### Control Flow
# → ## Trade-offs

# JSON format — useful for programmatic inspection
obsidian outline path=wiki/concepts/foo.md format=json

# Markdown format — renders as actual markdown headings
obsidian outline path=wiki/concepts/foo.md format=md

# Count headings only (cheapest possible probe)
obsidian outline path=wiki/concepts/foo.md total
```

|Aspect|Behavior|
|-|-|
|`path=` / `file=`|Required. Vault-relative path or file name.|
|`format=tree\|md\|json`|Optional. Default: `tree` (indented hierarchy). `json` for structured, `md` for rendered.|
|`total`|Optional. Return heading count only.|
|Output|Heading tree or count.|
|Exit|0 success; 1 error.|

**When to use:** Before deciding to read a full page, run `outline` to check if the file actually covers what you need. If the section headings don't match the question, skip the full read.

#### `read-head` (wrapper-only)

Read first N lines of a vault file. Includes both frontmatter and body content (the raw file from `obsidian read`, piped through `head`). Default N=20 covers the frontmatter block plus the first paragraph for most wiki pages — ~200 tokens vs ~1,000+ for a full read.

```bash
obsidian read-head path=wiki/concepts/foo.md
obsidian read-head path=wiki/hot.md lines=10
```

|Aspect|Behavior|
|-|-|
|`path=`|Required. Vault-relative path.|
|`lines=N`|Optional. Positive integer. Default: 20.|
|Output|First N lines of the raw file — frontmatter (`---` block) + body.|
|Exit|0 success; 1 error (bad args, missing file via underlying read).|

#### `read-tail`

Read last N lines of a vault file. Returns raw file content (both frontmatter and body) from the bottom. Useful for append-only files (`wiki/log.md`, `daily/*.md`) where the newest content is at the bottom. Default N=20.

```bash
obsidian read-tail path=wiki/log.md
obsidian read-tail path=daily/2026-06-06.md lines=10
```

|Aspect|Behavior|
|-|-|
|`path=`|Required. Vault-relative path.|
|`lines=N`|Optional. Positive integer. Default: 20.|
|Output|Last N lines of the raw file — may include frontmatter for short files, body-only for long files.|
|Exit|0 success; 1 error (bad args, missing file via underlying read).|

#### `grep`

Search within a single vault file. Returns matching lines without loading the full file into LLM context. Uses `obsidian read | grep` underneath.

```bash
obsidian grep path=wiki/hot.md pattern="agent" context=2
obsidian grep path=wiki/index.md pattern="orphan" ignore-case=true
```

|Aspect|Behavior|
|-|-|
|`path=`|Required. Vault-relative path.|
|`pattern=`|Required. Extended regex (grep -E syntax).|
|`context=N`|Optional. Lines of surrounding context. Default: 0.|
|`ignore-case=true`|Optional. Case-insensitive match. Default: false.|
|Output|Matching lines (grep format).|
|Exit|0 matches found; 1 no matches or error.|

#### `grep-files`

Search for a pattern across multiple vault files. Uses filesystem grep directly (read-only, low risk) — much faster than per-file `obsidian read`. Default scope is `wiki/`. Limited to 50 matches to prevent flooding context.

```bash
obsidian grep-files pattern="hot cache" context=1
obsidian grep-files pattern="orchestration" dir=wiki/concepts ignore-case=true
```

|Aspect|Behavior|
|-|-|
|`pattern=`|Required. Extended regex (grep -E syntax).|
|`dir=`|Optional. Vault-relative directory. Default: `wiki`.|
|`context=N`|Optional. Lines of surrounding context. Default: 0.|
|`ignore-case=true`|Optional. Case-insensitive match. Default: false.|
|Output|Matching lines with vault-relative filename prefix.|
|Exit|0 matches found; 1 no matches; 2 bad args (dir not found).|

### 3.3 `create-or-append` (wrapper-only)

Atomic "create or append" (prevents read-modify-overwrite races per issue #98).

```bash
obsidian create-or-append \
  file=daily/YYYY-MM-DD.md \
  template="---\ntype: daily\n...\n---\n\n## Captures\n" \
  content="- HH:MM <verbatim text>"
```

|Aspect|Behavior|
|-|-|
|File missing|Create via template, then append content|
|File exists|Append content only; template ignored|
|`template=`|Required|
|Output (missing)|`Created and appended: <path>`|
|Output (exists)|`Appended to: <path>`|
|Exit|0 success; 1 on error|

Does NOT read body or touch frontmatter. Use `property:set` (§3.4) for `updated:` mutations.

### 3.4 Native property verbs

Read, write, or remove a single frontmatter property without touching the file body.

```bash
# Read one property value
obsidian property:read name=updated path=daily/YYYY-MM-DD.md

# Set (or insert) a property — type= is optional; omit for plain text
obsidian property:set name=updated value=YYYY-MM-DD type=date path=daily/YYYY-MM-DD.md

# Remove a property
obsidian property:remove name=draft path=wiki/concepts/foo.md

# List all properties of a file (yaml output by default)
obsidian properties path=wiki/concepts/foo.md
```

|Verb|Required args|Optional args|
|-|-|-|
|`property:read`|`name=`|`file=` or `path=`|
|`property:set`|`name=`, `value=`|`type=text\|list\|number\|checkbox\|date\|datetime`, `file=` or `path=`|
|`property:remove`|`name=`|`file=` or `path=`|
|`properties`|—|`file=` or `path=`, `name=`, `total`, `sort=count`, `counts`, `format=yaml\|json\|tsv`|

**Re-spike after CLI version bump:** add `property:*` cases to `scripts/cli-spike.sh` and capture results.

### 3.5 File life-cycle verbs

Delete, move, or rename vault files. These are destructive — use with care.

```bash
# Delete (to trash by default)
obsidian delete path=wiki/concepts/stale-draft.md

# Permanent delete (skip trash)
obsidian delete path=_spike-scratch/temp.md permanent

# Move to a different folder
obsidian move path=notes/quick-thought.md to=wiki/concepts/

# Rename in place
obsidian rename path=wiki/concepts/old-name.md name=new-name
```

|Verb|Required args|Optional args|
|-|-|-|
|`delete`|`file=` or `path=`|`permanent` (skip trash)|
|`move`|`file=` or `path=`, `to=`|—|
|`rename`|`file=` or `path=`, `name=`|—|

### 3.6 Discovery & info verbs

These verbs help agents understand vault structure, find files, and inspect metadata without reading full file bodies.

**List files:** `obsidian files` lists vault paths. Filter by folder or extension. Combines with `jq` for structured queries:

```bash
# List all markdown files in a folder
obsidian files folder=wiki/concepts ext=md

# Count files in vault
obsidian files total

# List all files as JSON (one object per line) → filter with jq
obsidian files folder=wiki/sources format=json | jq -r '.[].path'
```

**File info:** `obsidian file` returns creation/modified timestamps and size:

```bash
obsidian file path=wiki/concepts/foo.md
# → path: wiki/concepts/foo.md
#    created: 2026-01-15 10:30
#    modified: 2026-06-01 14:22
#    size: 2842 bytes
#    extension: md
```

**Folder info:** `obsidian folder` returns folder stats:

```bash
# All info
obsidian folder path=wiki/concepts

# Single stat
obsidian folder path=wiki/concepts info=files
```

**Outgoing links:** `obsidian links` lists wikilinks from a file:

```bash
obsidian links path=wiki/concepts/foo.md
# → [[bar]]
#    [[baz|Display Name]]
```

**Word count:** `obsidian wordcount` for lint and token estimation:

```bash
# Full stats
obsidian wordcount path=wiki/hot.md
# → Words: 420, Characters: 2800

# Single stat
obsidian wordcount path=wiki/hot.md words
```

**Vault info:** `obsidian vault` for top-level context:

```bash
obsidian vault
obsidian vault info=files
obsidian vault info=size
```

### 3.7 Daily-note verbs

Native CLI verbs for daily-note operations, exposed because daily notes get enough traffic to warrant dedicated commands. These operate on the **current day's** daily note (resolved by Obsidian's daily-note plugin setting, typically `daily/YYYY-MM-DD.md`).

```bash
# Get today's daily note path (resolve the date-based filename)
path=$(obsidian daily:path)
# → daily/2026-06-06.md

# Read today's daily note
obsidian daily:read

# Append to today's daily note
obsidian daily:append content="- 14:00 finished the CLI reference update"

# Prepend to today's daily note (newest entries at top)
obsidian daily:prepend content="- 14:00 finished the CLI reference update"
```

`daily:append` and `daily:prepend` are convenience wrappers around `append`/`prepend` that automatically resolve `file=` to the current daily note. They are safe for single-agent use but do NOT have the create-or-append race guard (issue #98) — for daily-file appends in multi-agent or cron contexts, prefer `create-or-append` (§3.3).

**`daily:path` is preferred over hard-coding `daily/$(date +%Y-%m-%d).md`** because it honours Obsidian's daily-note format setting (some vaults use `YYYYMMDD` or other formats).

### 3.8 Task verbs

List or update tasks across the vault or within a specific file.

```bash
# List all incomplete tasks
obsidian tasks todo

# List tasks from daily note
obsidian tasks daily

# List tasks in a specific file, grouped with line numbers
obsidian tasks path=daily/2026-06-06.md verbose

# Toggle a task by reference (path:line)
obsidian task ref="daily/2026-06-06.md:15" toggle

# Mark a task done by path + line
obsidian task path=daily/2026-06-06.md line=15 done

# Set a custom status character
obsidian task path=daily/2026-06-06.md line=15 status="/"
```

|Verb|Args|Notes|
|-|-|-|
|`tasks`|`file=` / `path=`, `total`, `done`, `todo`, `status=`, `verbose`, `format=json\|tsv\|csv`, `active`, `daily`|List tasks. Default format: text (one line per task). `format=json` for structured output.|
|`task`|`ref=`, `file=` / `path=`, `line=`, `toggle`, `done`, `todo`, `status=`, `daily`|Show or update a single task. `ref` is `path:line` format. One action per call.|

### 3.9 Maintenance verbs

```bash
# Reload vault after external changes
obsidian reload

# List registered command IDs (useful for `command id=`)
obsidian commands filter=app:

# Execute a named command (escape hatch #1)
obsidian command id=app:open-vault

# List templates
obsidian templates

# Read template content (optionally with variables resolved)
obsidian template:read name=concept resolve title="My Concept"
```

**Re-spike after CLI version bump:** add new verbs to `scripts/cli-spike.sh` and capture results.

## 4. Cron-time behavior

CLI requires Obsidian running; cron context fails at pre-flight (exit 3). See issue #52 for workaround.

## 5. Documented exceptions

For the canonical list of paths where direct `Read` / `Write` / `Edit` on vault files is permitted because the CLI cannot serve the operation, see `${MEMO_PLUGIN_PWD}/skills/vault-ops/SKILL.md`. That list (binary files, canvas, JSON admin artifacts, `.raw/**` reads) is enforced by `hooks/block-direct-vault-io.sh`.

Non-vault exceptions still relevant to the CLI:

|Context|Why|
|-|-|
|Cron writes|Obsidian closed; CLI pre-flight fails (§4). See issue #52.|
|`bin/setup-vault.sh`, `bin/seed-demo.sh`|Bootstrap runs before vault registration; vault path not yet resolvable.|

## 6. Canvas file handling

Canvas files (`.canvas`) lack CLI verbs. Mix standard verbs + direct reads:

|Operation|Approach|
|-|-|
|List|`obsidian files dir=wiki/canvases format=json`|
|Read|Direct FS read (bypass due to `content=` asymmetry)|
|Extract wikilinks|Parse `.nodes[]?.text` for `[[...]]`; `obsidian unresolved` doesn't cover canvas|
|Verify dead links|Build FS resolver pool; test against it (ref: `scripts/lint-scan.sh`)|
|Write|Direct FS write (bypass; `content=` would corrupt literal `\n`)|
|Backlinks|`obsidian backlinks path=wiki/canvases/foo.canvas format=json`|

**`obsidian files` verb:** `obsidian files dir=<dir> format=json` → array of `{"path": "..."}`. Filter extensions client-side with `jq`.

## 7. Re-spiking after CLI version bump

Run `scripts/cli-spike.sh` and diff `tests/spike-results/`. Update this file if:
- New error patterns in stdout
- Verb gains `format=json` support (update §3 table)
- Exit codes change
- New verb relevant to skills
