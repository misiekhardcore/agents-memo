# PROMOTE Procedure

`/memo-wiki promote <tag>` → Execute:

1. Resolve tag slug (kebab-case, strip leading `#`).
2. Collect all leaves with `tags:` containing the resolved tag across `wiki/concepts/`, `wiki/entities/`, `wiki/sources/`.
3. Bail if fewer than 5 leaves: report count, suggest growing the cluster.
4. Bail if `wiki/domains/<tag>/_index.md` already exists.
5. Create hub at `wiki/domains/<tag>/_index.md` with `type: domain` frontmatter and `related:` list of all cluster leaves.
6. Register hub in `wiki/index.md` under `## Domains`.
7. Log in `wiki/log.md`.
