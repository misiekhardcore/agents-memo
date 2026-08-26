# Split Rubric

## Atomic-thought rule

Atomic thought = one self-contained idea. Split when topic/claim/referent shifts. Do not split mid-argument or merge distinct claims. Preserve content verbatim; only boundaries are chosen.

Zero chunks (unexpected empty result from reasoning step) → hard-abort, no retry:

```text
/memo-braindump split returned no chunks. Original text not captured.
```

## Examples

**Three independent thoughts (→ 3 chunks):**

```text
I keep forgetting to check the lint score before PRs.
Also need to revisit the hot cache size — it's been growing.
And the daily skill confirmation message looks wrong in dark mode.
```
→ 3 chunks

**Single thought (no spurious split):**

```text
The slug truncation rule needs to account for multi-byte unicode characters — right now
it can split in the middle of a grapheme cluster, which breaks vault filenames on some
filesystems.
```
→ 1 chunk (one idea, multiple sentences building on same topic)

**Narrative (order matters):**

```text
First, run lint. Then fix all errors in order of severity.
```
→ 2 chunks, order matters (sequential steps)
