---
name: wiki
description: Knowledge companion. Bootstraps vault, scaffolds structure, routes to sub-skills.
when_to_use: Use to bootstrap the vault (`/wiki init`) or scaffold its structure. Routes to sub-skills for domain operations.
model: opus
effort: medium
user-invocable: true
allowed-tools: Bash Read
---
Build and maintain persistent, compounding wiki in Obsidian vault. Wiki is product; chat is interface.

## I/O
- Input: User request (init, scaffold, promote tag, or route to sub-skill).
- Output: Vault structure, wiki pages, or sub-skill dispatch.

## Process
1. **Route**: Map user request to sub-skill per the operations routing table in `references/architecture.md`.
2. **INIT**: `bash "${MEMO_PLUGIN_PWD}/bin/wiki-init.sh" "${user_config.vault_path}"` — idempotent vault bootstrap.
3. **SCAFFOLD**: Per `references/scaffold.md` — 10-step procedure (folders, seed files, git init).
4. **PROMOTE**: Per `references/promote.md` — tag resolution, leaf collection, hub creation, index registration.
5. **Maintain**: Update hot cache and index/log after every operation.

## Rules
- Never modify `.raw/`.
- Forward-only hubs: promote roads, not gardens.
- Cross-project: add vault reference pointer per `references/architecture.md`.
