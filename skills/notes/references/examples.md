# Examples

**Capture (NEW):**

```text
user> /memo-note inbox count missing from /memo-wiki status
assistant> Captured to notes/2026-04-25-inbox-count-missing-from-wiki-status.md
```

**Capture (NEW, filler stripped from title):**

```text
user> /memo-note we need to check why agents-flow is not using 'wt' for worktrees but the git cli directly
# title summarised to "agents-flow uses git CLI instead of wt for worktrees"
# slug exceeds 40 chars; truncated at last `-` before char 40
assistant> Captured to notes/2026-04-26-agents-flow-uses-git-cli-instead.md
```

**Capture (MATCH-append, scope unchanged):**

```text
user> note this: still seeing the same flaky behaviour on macOS
assistant> Appended to notes/2026-04-22-flaky-macos-runner.md
```

**Capture (MATCH-append with title rewrite):**

```text
user> /memo-dump same issue now reproduces on Linux too
# existing note title was "flaky macOS runner"; new content broadens scope
assistant> Appended to notes/2026-04-22-flaky-macos-runner.md
# title rewritten to "flaky CI runner (macOS + Linux)", filename unchanged
```

**List, filtered:**

```text
user> /memo-note list --project=agents-memo
assistant>
Pending notes (2):

- [ ] 2026-04-25 [agents-memo] /memo-note process should reuse confidence threshold
- [ ] 2026-04-24 [agents-memo] inbox count missing from /memo-wiki status

Deferred (1):

- [~] 2026-04-12 [agents-memo] consider auto-tagging from CWD remote name
```

**Process:**

```text
user> /memo-note process
assistant>
[1/3] 2026-04-25 [agents-memo]
title: /memo-note process should reuse confidence threshold from save
body:
> /memo-note process should reuse confidence threshold from save

Action? [s]ave / [d]efer / [x]delete / [q]uit
user> s
# /memo-save invoked, wiki page created, note removed from notes/
assistant> Saved as [[Confidence threshold reuse]] in wiki/concepts/. Note deleted.
```

**URL redirect (yes):**

```text
user> /memo-note https://example.com/article
assistant> Detected URL: https://example.com/article. Ingest via /memo-ingest? [y/n]
user> y
# /memo-ingest invoked, wiki page created, URL processed
assistant> Ingested via /memo-ingest: [[Article Title]]
```

**URL redirect (no):**

```text
user> /memo-note https://example.com/article
assistant> Detected URL: https://example.com/article. Ingest via /memo-ingest? [y/n]
user> n
# standard CAPTURE proceeds, URL captured as text
assistant> Captured to notes/2026-04-27-example-article-url.md
```
