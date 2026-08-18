#!/usr/bin/env bash
# obsidian-cli.sh — wrapper for the Obsidian CLI used by every agents-memo skill.
#
# Resolves the vault, derives the vault name (basename), pre-flights
# `obsidian version`, runs the verb, and normalizes the upstream CLI's
# always-zero exit code into something callers can act on. stdout/stderr from
# the underlying CLI are passed through verbatim — the exit code is the only
# normalization on the output channel.
#
# Usage:
#   scripts/obsidian-cli.sh <verb> [arg=value ...]
#   scripts/obsidian-cli.sh --help | -h
#
# A PreToolUse Bash hook (hooks/obsidian-cli-rewrite.sh) transparently rewrites
# raw `obsidian <verb> ...` calls into this wrapper. Skills should still invoke
# the wrapper explicitly; the rewrite is a guard rail for raw shell-outs.
#
# ─── Exit codes ──────────────────────────────────────────────────────────────
#   0 — success
#   1 — generic CLI error      (stdout starts with "Error:")
#   2 — vault not found        (stdout literal first line "Vault not found.")
#   3 — pre-flight failed      (binary missing, Obsidian not running, no version)
#   4 — vault resolution failed (resolve-vault.sh exited non-zero)
#
# Callers that want hook-style fail-soft pipe `|| exit 0`.
#
# ─── stdout error patterns the wrapper detects ───────────────────────────────
# Upstream always returns exit 0; the wrapper inspects only the first line of
# stdout to decide between success and the error codes above.
#
#   "Error: File \"<path>\" not found."         → exit 1 (read/append/prepend
#                                                          against missing file)
#   "Error: Command \"<verb>\" not found. ..."  → exit 1 (unknown verb)
#   "Error: Command \"<id>\" not found. ..."    → exit 1 (bad `command id=...`)
#   "Error: No active file. ..."                → exit 1 (verb needs a file)
#   "Vault not found."                          → exit 2 (wrong vault name, or
#                                                         a path was passed)
#   <empty stdout, exit 0>                      → exit 0 (e.g. command id=...)
#   <non-empty stdout, no Error: prefix>        → exit 0 (success)
#
# New error shapes from a future CLI version must be captured by re-running
# scripts/cli-spike.sh and added here.
#
# ─── vault=<name> is name-only ───────────────────────────────────────────────
# The CLI's `vault=` parameter accepts a vault NAME (basename), not a path.
# Passing `vault=/some/path` returns "Vault not found." with exit 0. The
# wrapper always passes the basename of $VAULT so callers never have to think
# about it.
#
# ─── Escape hatches (in increasing risk order) ───────────────────────────────
#   1. `obsidian-cli.sh command id=<command-id>` — runs an Obsidian command by
#      ID (same IDs as the command palette). Discover with
#      `obsidian-cli.sh commands filter=<prefix>`. Freely allowed.
#   2. `obsidian-cli.sh eval code=<js>` — runs arbitrary JS in Obsidian's
#      renderer. Last resort. Every call needs a per-call comment in the
#      calling skill explaining why no structured verb suffices.
#   3. Direct Read/Write/Edit on vault files — reserved for the documented
#      exceptions below. Don't entrench bug workarounds; file the bug.
#
# ─── Documented exceptions (bypasses are intentional) ────────────────────────
#   • .raw/.manifest.json           — bookkeeping for raw inbox; not a wiki page
#   • _attachments/images/**        — binary writes; CLI has no binary verb
  #   • cron-time writes when Obsidian is closed
#   • bin/setup-vault.sh, bin/seed-demo.sh — operate before vault registration
#
# ─── Wrapper-only verbs ──────────────────────────────────────────────────────
# These verbs are not part of the upstream CLI; the wrapper synthesizes them
# from the underlying primitives. They exist so callers (notably skills/daily)
# never have to read-modify-overwrite a file at the model layer, and so
# skills can read partial file content without loading the full file into the
# LLM context window.
#
#   create-or-append  file=<path> template=<full-file-template> content=<bullet>
#     File missing → write `template` via `obsidian create`, then append
#     `content`. File exists → append `content` only; `template` is ignored.
#     `template` is required (no caller needs empty-template create).
#     Output: `Created and appended: <path>` (file-missing branch) or
#             `Appended to: <path>` (file-exists branch).
#     Exit:   0 success, 1 generic error (e.g. underlying create/append failed).
#
#   read-head  path=<vault-relative-path> [lines=N]
#     Reads the first N lines of a vault file. Designed to save context — the
#     LLM sees only the head of the file (frontmatter + intro), not the full
#     body. Default N=20 (covers frontmatter + first paragraph for most pages).
#     Underlying implementation: `obsidian read | head -n N`.
#     Output: first N lines of the file (may be empty for blank files).
#     Exit:   0 success, 1 via underlying read error.
#
#   read-tail  path=<vault-relative-path> [lines=N]
#     Reads the last N lines of a vault file. Useful for append-only files
#     (wiki/log.md, daily/*.md) where the newest content is at the bottom.
#     Default N=20. Underlying implementation: `obsidian read | tail -n N`.
#     Output: last N lines of the file.
#     Exit:   0 success, 1 via underlying read error.
#
#   grep  path=<vault-relative-path> pattern=<substring-or-regex> [context=N] [ignore-case=true]
#     Searches within a single vault file. Returns matching lines with
#     optional surrounding context. Uses `obsidian read | grep` underneath so
#     the full file never enters the LLM context — only the matches.
#     Default context=0 (match lines only). ignore-case=false by default.
#     Output: matching lines (grep format, with filename prefix for multi-file).
#     Exit:   0 matches found, 1 no matches or error.
#
#   grep-files  pattern=<substring-or-regex> [dir=<vault-relative-dir>] [context=N] [ignore-case=true]
#     Searches for a pattern across multiple vault files. Uses filesystem grep
#     directly (read-only, low risk) — much faster than per-file obsidian read.
#     Default dir=wiki (safest scope). Returns up to 50 matches.
#     Pattern should be a basic regex (grep -E syntax).
#     Output: matching lines with filename prefix, grouped by file.
#     Exit:   0 matches found, 1 no matches, 2 bad args.
#
#   read-canvas  path=<vault-relative-path>
#     Reads a .canvas file and emits structured plain text: groups as ##
#     sections (children sorted top-to-bottom), edges as a flat resolved list.
#     Strips all layout fields (x/y/width/height/color/id). Callers never have
#     to know about the underlying read-canvas.sh script.
#     Output: plain text (see scripts/read-canvas.sh for format spec).
#     Exit:   0 success, 1 bad args, 2 file not found, 3 parse error.
#
# ─── Empirical contract ──────────────────────────────────────────────────────
# Every behavior above is verified by tests/cli-smoke.sh and backed by the
# captures in tests/spike-results/. After every Obsidian CLI minor-version
# bump, re-run scripts/cli-spike.sh and update this header if the contract
# changes.
#
# Verb signatures live in three places — this header contract, the `--help`
# heredoc, and the cli-smoke assertions — a new wrapper verb must update all
# three.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 0. --help / -h short-circuit — must run BEFORE vault resolution and
#    pre-flight so usage works with no vault configured and no Obsidian
#    running. Unknown --* flags are NOT intercepted here; they fall through
#    to the upstream CLI unchanged.
case "${1:-}" in
  --help|-h)
    cat <<'EOF'
Usage:
  scripts/obsidian-cli.sh <verb> [arg=value ...]
  scripts/obsidian-cli.sh --help | -h

Wrapper verbs (synthesized by this script):
  create-or-append  file=<path> template=<full-file-template> content=<bullet>
    Example: create-or-append file=notes/foo.md template="## Notes" content="- bullet"
  read-head  path=<vault-relative-path> [lines=N]
    Example: read-head path=notes/x.md lines=20
  read-tail  path=<vault-relative-path> [lines=N]
    Example: read-tail path=notes/x.md lines=20
  grep  path=<vault-relative-path> pattern=<substring-or-regex> [context=N] [ignore-case=true]
    Example: grep path=wiki pattern=foo
  grep-files  pattern=<substring-or-regex> [dir=<vault-relative-dir>] [context=N] [ignore-case=true]
    Example: grep-files pattern=foo dir=wiki
  read-canvas  path=<vault-relative-path>
    Example: read-canvas path=wiki/canvases/main.canvas

Common upstream verbs (passed through to the Obsidian CLI):
  read, append, prepend, create, search, commands, tags, backlinks, outline,
  bookmarks, orphans, deadends, tasks, properties, aliases, unresolved,
  eval, command
  Example: read path=wiki/index.md
  Full verb list: obsidian --help
EOF
    exit 0
    ;;
esac

# 1. Resolve vault path. Failure is exit 4 — callers that want fail-soft chain `|| exit 0`.
VAULT="$("$SCRIPT_DIR/resolve-vault.sh")" || exit 4
[ -n "$VAULT" ] || exit 4

# 2. Derive vault name (basename) — CLI accepts vault=<name>, not path.
VAULT_NAME="$(basename "$VAULT")"

# 3. Pre-flight: obsidian binary present and Obsidian running.
#    `obsidian version` returns "X.Y.Z (installer A.B.C)" when the desktop app
#    is reachable. Empty output or non-zero exit → bail with exit 3.
if ! command -v obsidian >/dev/null 2>&1; then
  echo "obsidian-cli: obsidian binary not on PATH" >&2
  exit 3
fi
VERSION_OUT="$(obsidian version 2>/dev/null || true)"
if [ -z "$VERSION_OUT" ]; then
  echo "obsidian-cli: 'obsidian version' returned no output (Obsidian not running?)" >&2
  exit 3
fi

# 4a. Wrapper-only verb (create-or-append) — see header.
#     Calls the underlying `obsidian` binary directly with the resolved
#     vault name; the upstream CLI's stdout-based error reporting is parsed
#     here without needing to recurse through this wrapper.

# run_obs <args...> — call upstream `obsidian` with the resolved vault name,
# print stdout verbatim, and return a normalized exit code (0/1/2 — see the
# header's exit-code table). Used only by the wrapper-only verbs below.
run_obs() {
  local tmp first cli_exit
  tmp="$(mktemp)"
  obsidian "$@" "vault=$VAULT_NAME" >"$tmp" 2>&2
  cli_exit=$?
  cat "$tmp"
  first="$(head -n 1 "$tmp" 2>/dev/null || true)"
  rm -f "$tmp"
  if [ "$cli_exit" -ne 0 ]; then return "$cli_exit"; fi
  case "$first" in
    "Vault not found."*) return 2 ;;
    "Error: "*)          return 1 ;;
    *)                   return 0 ;;
  esac
}

# do_create_or_append — see header for the contract.
do_create_or_append() {
  local file="" template="" content=""
  for arg in "$@"; do
    case "$arg" in
      file=*)     file="${arg#file=}" ;;
      template=*) template="${arg#template=}" ;;
      content=*)  content="${arg#content=}" ;;
      *) echo "Error: create-or-append: unknown argument '$arg'" >&2; return 1 ;;
    esac
  done
  if [ -z "$file" ] || [ -z "$template" ] || [ -z "$content" ]; then
    echo "Error: create-or-append requires file=, template=, and content=" >&2
    return 1
  fi

  # File-exists fast path: try `append` directly. The upstream CLI returns
  # `Error: File "<path>" not found.` on a missing file, otherwise
  # `Appended to: <path>`. One call covers the common case (file exists);
  # only the cold-start (file missing) path pays for the extra `create`.
  # We avoid a separate `read` probe so we don't pull a possibly-large body
  # into memory just to learn whether the file exists.
  local append_out append_first append_rc
  append_out="$(mktemp)"
  obsidian append "file=$file" "content=$content" "vault=$VAULT_NAME" \
    >"$append_out" 2>&2
  append_rc=$?
  append_first="$(head -n 1 "$append_out" 2>/dev/null || true)"
  rm -f "$append_out"

  if [ "$append_rc" -eq 0 ]; then
    case "$append_first" in
      "Appended to: "*)
        echo "Appended to: $file"
        return 0
        ;;
      'Error: File "'*)
        # Fall through to create+append.
        ;;
      "Error: "*)
        echo "$append_first"
        return 1
        ;;
      *)
        # Treat any other non-error first line as a successful append.
        echo "Appended to: $file"
        return 0
        ;;
    esac
  fi

  # File-missing branch: create with template, then append the bullet.
  if ! run_obs create "path=$file" "content=$template" >/dev/null; then
    echo "Error: create-or-append: failed to create $file" >&2
    return 1
  fi
  if ! run_obs append "file=$file" "content=$content" >/dev/null; then
    echo "Error: create-or-append: created $file but append failed" >&2
    return 1
  fi
  echo "Created and appended: $file"
  return 0
}

# do_read_head — see header for the contract.
do_read_head() {
  local path="" lines="20"
  for arg in "$@"; do
    case "$arg" in
      path=*)  path="${arg#path=}" ;;
      lines=*) lines="${arg#lines=}" ;;
      *) echo "Error: read-head: unknown argument '$arg'" >&2; return 1 ;;
    esac
  done
  if [ -z "$path" ]; then
    echo "Error: read-head requires path=<vault-relative-path>" >&2
    return 1
  fi
  if ! [[ "$lines" =~ ^[0-9]+$ ]] || [ "$lines" -lt 1 ]; then
    echo "Error: read-head: lines must be a positive integer" >&2
    return 1
  fi
  run_obs read "path=$path" 2>/dev/null | head -n "$lines"
  local rc="${PIPESTATUS[0]}"
  return "$rc"
}

# do_read_tail — see header for the contract.
do_read_tail() {
  local path="" lines="20"
  for arg in "$@"; do
    case "$arg" in
      path=*)  path="${arg#path=}" ;;
      lines=*) lines="${arg#lines=}" ;;
      *) echo "Error: read-tail: unknown argument '$arg'" >&2; return 1 ;;
    esac
  done
  if [ -z "$path" ]; then
    echo "Error: read-tail requires path=<vault-relative-path>" >&2
    return 1
  fi
  if ! [[ "$lines" =~ ^[0-9]+$ ]] || [ "$lines" -lt 1 ]; then
    echo "Error: read-tail: lines must be a positive integer" >&2
    return 1
  fi
  run_obs read "path=$path" 2>/dev/null | tail -n "$lines"
  local rc="${PIPESTATUS[0]}"
  return "$rc"
}

# do_grep — see header for the contract.
do_grep() {
  local path="" pattern="" context="0" ignore_case=""
  for arg in "$@"; do
    case "$arg" in
      path=*)       path="${arg#path=}" ;;
      pattern=*)    pattern="${arg#pattern=}" ;;
      context=*)    context="${arg#context=}" ;;
      ignore-case=*) ignore_case="${arg#ignore-case=}" ;;
      *) echo "Error: grep: unknown argument '$arg'" >&2; return 1 ;;
    esac
  done
  if [ -z "$path" ] || [ -z "$pattern" ]; then
    echo "Error: grep requires path=<vault-relative-path> and pattern=<string>" >&2
    return 1
  fi
  if ! [[ "$context" =~ ^[0-9]+$ ]]; then
    echo "Error: grep: context must be a non-negative integer" >&2
    return 1
  fi
  local grep_opts=()
  if [ "$context" -gt 0 ]; then
    grep_opts+=(-C "$context")
  fi
  if [ "$ignore_case" = "true" ]; then
    grep_opts+=(-i)
  fi
  grep_opts+=(-E)
  local tmp rc
  tmp="$(mktemp)"
  if ! run_obs read "path=$path" >"$tmp" 2>&2; then
    rm -f "$tmp"
    return 1
  fi
  local matches
  matches=$(grep "${grep_opts[@]}" -- "$pattern" "$tmp" 2>/dev/null || true)
  rm -f "$tmp"
  if [ -z "$matches" ]; then
    return 1
  fi
  echo "$matches"
  return 0
}

# do_grep_files — see header for the contract.
do_grep_files() {
  local pattern="" dir="wiki" context="0" ignore_case=""
  for arg in "$@"; do
    case "$arg" in
      pattern=*)    pattern="${arg#pattern=}" ;;
      dir=*)        dir="${arg#dir=}" ;;
      context=*)    context="${arg#context=}" ;;
      ignore-case=*) ignore_case="${arg#ignore-case=}" ;;
      *) echo "Error: grep-files: unknown argument '$arg'" >&2; return 1 ;;
    esac
  done
  if [ -z "$pattern" ]; then
    echo "Error: grep-files requires pattern=<string>" >&2
    return 1
  fi
  if ! [[ "$context" =~ ^[0-9]+$ ]]; then
    echo "Error: grep-files: context must be a non-negative integer" >&2
    return 1
  fi
  local abs_dir="$VAULT/$dir"
  if [ ! -d "$abs_dir" ]; then
    echo "Error: grep-files: directory not found: $abs_dir" >&2
    return 2
  fi
  local grep_opts=()
  grep_opts+=(-r -n)
  if [ "$context" -gt 0 ]; then
    grep_opts+=(-C "$context")
  fi
  if [ "$ignore_case" = "true" ]; then
    grep_opts+=(-i)
  fi
  grep_opts+=(-E)
  # Respect .gitignore and skip binary files. Limit to 50 matches.
  local matches
  matches=$(grep "${grep_opts[@]}" -- "$pattern" "$abs_dir" \
    --exclude-dir=.git 2>/dev/null | head -50 || true)
  if [ -z "$matches" ]; then
    return 1
  fi
  # Strip the absolute vault prefix from paths for cleaner output
  echo "$matches" | sed "s|$VAULT/||g"
  return 0
}

# do_read_canvas — see header for the contract.
do_read_canvas() {
  local path=""
  for arg in "$@"; do
    case "$arg" in
      path=*) path="${arg#path=}" ;;
      *) echo "Error: read-canvas: unknown argument '$arg'" >&2; return 1 ;;
    esac
  done
  if [ -z "$path" ]; then
    echo "Error: read-canvas requires path=<vault-relative-path>" >&2
    return 1
  fi
  local abs_path="$VAULT/$path"
  if [ ! -f "$abs_path" ]; then
    echo "Error: read-canvas: file not found: $abs_path" >&2
    return 2
  fi
  "$SCRIPT_DIR/read-canvas.sh" "$abs_path"
}

case "${1:-}" in
  create-or-append) shift; do_create_or_append "$@"; exit $? ;;
  read-head)        shift; do_read_head "$@";        exit $? ;;
  read-tail)        shift; do_read_tail "$@";        exit $? ;;
  grep)             shift; do_grep "$@";             exit $? ;;
  grep-files)       shift; do_grep_files "$@";       exit $? ;;
  read-canvas)      shift; do_read_canvas "$@";       exit $? ;;
esac

# 4. Run the verb. Capture stdout so we can inspect it for error markers.
#    The CLI itself always exits 0, so its real exit is uninformative — we
#    detect errors from stdout per the patterns in this script's header.
TMP_OUT="$(mktemp)"
trap 'rm -f "$TMP_OUT"' EXIT

obsidian "$@" "vault=$VAULT_NAME" >"$TMP_OUT" 2>&2
CLI_EXIT=$?

# 5. Pass stdout through to the caller verbatim.
cat "$TMP_OUT"

# 6. Normalize exit code based on stdout's first line.
FIRST_LINE="$(head -n 1 "$TMP_OUT" 2>/dev/null || true)"

# Honour the CLI's own non-zero exit if it ever emits one.
if [ "$CLI_EXIT" -ne 0 ]; then
  exit "$CLI_EXIT"
fi

case "$FIRST_LINE" in
  "Vault not found."*) exit 2 ;;
  "Error: "*)          exit 1 ;;
  *)                   exit 0 ;;
esac
