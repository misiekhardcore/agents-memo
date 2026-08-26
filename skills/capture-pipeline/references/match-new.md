# MATCH/NEW Heuristic

Used by `/memo-note` and `/memo-braindump`. `/memo-daily` is append-only (no MATCH/NEW).

## Enumeration

List `<vault_root>/notes/*.md` (frontmatter only; skip bodies, `notes/index.md`, `status: deferred`). Cap at 20 most recent by `updated:`. Use `obsidian properties path=notes/<file>` per candidate.

## Decision

One of: `MATCH: <filename> | <reason>` or `NEW`.

MATCH only if **all three hold:**
1. Title or topic alignment (same subject, not just domain)
2. Tag overlap ≥1, OR tags empty on both with strong title/topic alignment
3. New content is logical extension (continuation, counter-example, follow-up on same topic)

Default to NEW on ambiguity; high bar for MATCH.

## MATCH path

Append to existing file with `---` separator. If new content broadens scope, rewrite `title:` to cover union. Bump `updated:`. Filename never changes.

## NEW path

1. Derive one-line title (≤80 chars), stripped of filler
2. Compute slug per §3
3. Path: `<vault_root>/notes/YYYY-MM-DD-<slug>.md`; collisions: `-2`, `-3`, …
4. Frontmatter per §2; body is verbatim text
