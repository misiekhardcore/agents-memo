# CAPTURE Operation — Full Procedure

## Step 1: Extract arguments

Everything after the trigger phrase. Scan for image-path tokens (any token that resolves to a path or carries a supported image extension); keep them separate. Join remaining non-path tokens as verbatim text in original order with single spaces. Do not include image-path tokens in verbatim text.

## Step 2: Image routing

If image paths present → Read `${MEMO_PLUGIN_PWD}/skills/image-capture/SKILL.md` first. Use that skill to determine image-specific bullet text and attachment handling. Then continue with steps 3–8 for the normal daily append flow.

## Step 3: Resolve vault

Resolve `<vault_root>` per [§1](${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md). Abort with `No vault configured — run /wiki init first.` if unresolved.

## Step 4: Compute date/time

Today as `YYYY-MM-DD`, current local time as `HH:MM` (24-hour, zero-padded).

## Step 5: Ensure directory

If `<vault_root>/daily/` does not exist, create silently with `mkdir -p`.

## Step 6: Append bullet

```bash
obsidian create-or-append \
  file=daily/YYYY-MM-DD.md \
  template="---\ntype: daily\ndate: YYYY-MM-DD\ncreated: YYYY-MM-DD\nupdated: YYYY-MM-DD\n---\n\n## Captures\n" \
  content="- HH:MM <verbatim text>"
```

`template` used only when file is missing; when file exists, wrapper appends `content` and ignores `template`. Shape per [§2](${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md).

## Step 7: Bump updated:

```bash
obsidian property:set \
  name=updated \
  value=YYYY-MM-DD \
  type=date \
  path=daily/YYYY-MM-DD.md
```

## Step 8: Confirm

```text
Logged to daily/YYYY-MM-DD.md
```

One line only. No diff, no reasoning.

## Idempotency and collision rules

Per [§7](${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md):

- Multiple calls in same minute land bullets with same `HH:MM` prefix in file order — no collision handling, no counter.
- No MATCH/NEW decision runs — every call adds a new bullet.

## Examples

**First call (file does not exist):**
```text
user> /daily shipped the /note slug rewrite
assistant> Logged to daily/2026-04-27.md
```

**Subsequent call (file exists):**
```text
user> log to today: pairing session with @dana on the wiki lint refactor
assistant> Logged to daily/2026-04-27.md
```

**Two calls in same minute:**
```text
user> /daily standup done
assistant> Logged to daily/2026-04-27.md
user> daily note this: retrospective rescheduled to Thursday
assistant> Logged to daily/2026-04-27.md
```

**No vault configured:**
```text
user> /daily fixed the flaky test
assistant> No vault configured — run /wiki init first.
```
