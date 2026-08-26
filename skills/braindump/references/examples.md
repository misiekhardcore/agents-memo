# Examples

**Multi-thought (3 independent → agent fan-out):**

```text
user> /memo-braindump I keep forgetting to check the lint score before PRs. Also need to revisit the hot cache size — it's been growing. And the daily skill confirmation message looks wrong in dark mode.
assistant>
Captured 3 notes:
- notes/2026-04-27-check-lint-score-before-prs.md
- notes/2026-04-27-hot-cache-size-growing.md
- notes/2026-04-27-daily-skill-confirmation-dark-mode.md
```

**Single thought (inline):**

```text
user> /memo-braindump The slug truncation rule needs to account for multi-byte unicode characters — right now it can split in the middle of a grapheme cluster, which breaks vault filenames on some filesystems.
assistant>
Captured 1 note:
- notes/2026-04-27-slug-truncation-multibyte-unicode.md
```

**File input (vault-relative):**

```text
user> /memo-braindump retro-notes/2026-04-feature-retro.txt
assistant>
Captured N notes:
- notes/2026-04-27-…
```

**One chunk fails:**

```text
assistant>
Captured 2 notes:
- notes/2026-04-27-check-lint-score-before-prs.md
- notes/2026-04-27-daily-skill-confirmation-dark-mode.md

Failed: 1 chunk.
- notes/: permission denied writing 2026-04-27-hot-cache-size-growing.md
```
