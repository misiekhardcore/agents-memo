---
name: memo-wiki
description: Knowledge companion. Routes operations to sub-skills, promotes tags, maintains the wiki.
when_to_use: Use to route vault operations (query, notes, daily, ingest, lint, canvas) to sub-skills, or to promote tags into wiki hubs. For vault initialization, tell the user to run /memo:init — the extension command owns setup.
model: opus
effort: medium
user-invocable: true
allowed-tools: Bash Read
---
Build and maintain persistent, compounding wiki in Obsidian vault. Wiki is product; chat is interface.

## I/O
- Input: User request (route to sub-skill, promote tag).
- Output: Sub-skill dispatch, wiki hubs, index/log updates.

## Process
1. **Route**: Map user request to sub-skill per the operations routing table in `references/architecture.md`.
2. **INIT**: If the user asks to initialize or scaffold a vault, do NOT run setup yourself — tell them to run `/memo:init` (the extension command). It bootstraps the vault, git-inits it, writes the vault `AGENTS.md`, and offers the weekly lint cron.
3. **PROMOTE**: Per `references/promote.md` — tag resolution, leaf collection, hub creation, index registration.
4. **Maintain**: Update hot cache and index/log after every operation.

## Rules
- Never modify `.raw/`.
- Forward-only hubs: promote roads, not gardens.
- Cross-project: add vault reference pointer per `references/architecture.md`.
