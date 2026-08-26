# Vault Resolution, Frontmatter Schema, Slug Rules

## 1. Vault path resolution

Resolve `<vault_root>` via `scripts/resolve-vault.sh` (canonical implementation).

Resolution order:
1. Legacy explicit path passed as `$1`
2. CWD if it contains `wiki/`
3. `agents-memo.vault_path` setting

```bash
VAULT=$(bash "${MEMO_PLUGIN_PWD}/scripts/resolve-vault.sh") || {
  echo "No vault configured — run /memo-wiki init first."
  exit 1
}
```

## 2. Frontmatter schema

Both use flat YAML per `_shared/frontmatter.md`. Captures omit universal fields (`confidence`, `evidence`, `related`, `sources` — reserved for polished pages).

### Note shape (`type: note`)

```yaml
---
type: note
title: "<one-line summary, ≤80 chars>"
topic: ""
tags: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
source_project: "<cwd basename at capture time>"
status: pending
---
```

- `topic` — optional free-text grouping
- `tags` — optional
- `source_project` — CWD basename; used by LIST `--project=…`
- `status` — `pending` | `deferred`

### Daily shape (`type: daily`)

```yaml
---
type: daily
date: YYYY-MM-DD
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

No `title`, `topic`, `tags`, `source_project`, or `status` — daily files are append-only chronological logs.

## 3. Slug rule (title-driven)

Use `scripts/slug.sh` (canonical implementation):

```bash
slug=$(bash "${MEMO_PLUGIN_PWD}/scripts/slug.sh" "$title" "$body")
```

Output: lowercase, hyphenated, max 40 chars. Exit 1 if both inputs empty.

- Note files: `<vault_root>/notes/YYYY-MM-DD-<slug>.md`
- Daily files: `<vault_root>/daily/YYYY-MM-DD.md` (no slug)
