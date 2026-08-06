# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Changed

- Rename plugin-root variable from `${CLAUDE_PLUGIN_ROOT}` to `${MEMO_PLUGIN_PWD}` across scripts, hooks, and skill docs (pi migration). Claude Code's `hooks.json` keeps `${CLAUDE_PLUGIN_ROOT}`; hook scripts fall back to script-location resolution when the variable is unset.
- Vault/config resolution now checks pi settings (`~/.pi/agent/settings.json`, then `.pi/settings.json`, `agentsMemo` block) before Claude Code settings and CWD `wiki/` discovery. A stale `agentsMemo.vaultPath` (missing or not a directory) falls through to the next tier instead of winning, mirroring the extension's existence check.

## [2.1.0] - 2026-06-16
### Changed

- Update descriptions in marketplace.json and plugin.json for clarity
- Update plugin description for clarity
- Update references from claude-obsidian to agents-memo
- Rename project from claude-obsidian to agents-memo
- Rebrand claude-obsidian → agents-memo
- Add markdown minification script and formatting rules
- Rebrand claude-obsidian → agents-memo
## [2.0.0] - 2026-06-16
### Added

- Align SKILL.md with CWF conventions
- Add git-cliff changelog handling

### Changed

- Phase 1: Restructure braindump skill
- Phase 1: Restructure notes skill
- Phase 1: Restructure daily + daily-close skills
- Phase 1: Restructure obsidian-bases skill
- Phase 1: Restructure ingest skill
- Phase 1: Restructure query skill to CWF conventions
- Phase 0c+0d+0e: seed-brief contract + protocol skill promotions
- Update permissions structure and disallowed tools for agents
- Update agent names and descriptions for clarity and consistency
- Phase 0a+0b: Agent file setup
- Remove NOTES.md from tracking
- Remove commands/ directory (dead pattern)
- Phase 1: Review-only skills — defuddle, save, wiki, lint (CWF conventions)
- Phase 1: Restructure canvas skill to CWF conventions
- Add memory-search skill + agent for obsidian CLI memory lookups
- Add read-head, grep, and grep-files wrapper verbs for context-saving vault reads
- Switch license from MIT to PolyForm Noncommercial 1.0.0

### Fixed

- Align with agents-flow — use npx git-cliff, add --unreleased flag
- Clarify mandatory steps and update index mapping for note types
## [1.8.0] - 2026-05-21
### Added

- Add read-canvas script that strips layout noise for LLM context

### Changed

- Release v1.8.0
## [1.7.2] - 2026-05-17
### Changed

- Release v1.7.2
- Simplify command detection and verb extraction
## [1.7.1] - 2026-05-17
### Changed

- Release v1.7.1
- Active vault I/O enforcement + skill / shared-doc consolidation
## [1.7.0] - 2026-05-15
### Changed

- Release v1.7.0
- Extract inline content to reference files, bring SKILL.md to 50-line cap

### Documentation

- Establish lazy-loading standard for skill reference files
## [1.6.0] - 2026-05-15
### Added

- Add bootstrap_read_index option to auto-inject wiki/index.md at session start

### Changed

- Release v1.6.0

### Fixed

- Enforce obsidian CLI for vault ops in agents and skills
## [1.5.2] - 2026-05-15
### Changed

- Release v1.5.2
- Remove session scratch log file

### Fixed

- Replace jq filter with grep -E for plain-text files output
- Fix backlinks unbound variable under set -u
## [1.5.1] - 2026-05-15
### Changed

- Release v1.5.1

### Fixed

- Resolve plugin root from script location, not CLAUDE_PLUGIN_ROOT
## [1.5.0] - 2026-05-14
### Added

- Log obsidian cli usage

### Changed

- Release v1.5.0
## [1.4.0] - 2026-05-12
### Changed

- Release v1.4.0
- Improve skill authoring quality: when_to_use, trim oversized skills, modularity

### Documentation

- Add cross-plugin scope boundary section to AUTHORING.md
## [1.3.0] - 2026-05-07
### Added

- Add when_to_use to multi-mode skills and expand AUTHORING.md (PR3)
- Remove Glob/Grep from 11 skills, drop obsidian-markdown allowed-tools, add disallowedTools to agents (PR2)
- Add Agent/WebFetch to allowed-tools and argument-hint to commands (PR1)

### Changed

- Release v1.3.0
- Move empty-sections check to lint-scan.sh
## [1.2.0] - 2026-05-07
### Added

- Sub-agent dispatch for capture/ingest/research/lint skills
- Update query skill documentation for clarity and formatting

### Changed

- Release v1.2.0
- Remove quotes from titles in markdown files for consistency
- Replace prettier with dprint for token-compact markdown formatting
- Tighten prettier for token efficiency (proseWrap never, printWidth 10000)
- Format vault to prettier + markdownlint baseline
- Exclude node_modules from tracking
- Add prettier + markdownlint formatting toolchain
- Demote checks #3–#5 to manual, trim skill descriptions

### Documentation

- Backfill 0.5.1 and 1.1.0 entries

### Fixed

- Quote {{today}} so prettier doesn't split it into {{today}}
- Handle empty backlinks output before piping to jq
- Pass vault= after verb, not before

### Testing

- Audit 16 lint checks and add tier-2 fixture vault
## [1.1.0] - 2026-05-03
### Added

- E2E harness — local full tier (entrypoint + assertions + Makefile)
- E2E harness — CI fast tier (Dockerfile + workflow)
- Emit trail page recording argument order per run
- Add check #15 — misplaced index entries by type
- Backlink-aware traversal and density check
- Add initial lint report for wiki metadata validation
- Convert 7 skills to Obsidian CLI wrapper
- Pre-authorize safe auto-fixes for unattended runs
- Rich capture inputs — image + URL redirect
- /daily-close as standalone skill
- /braindump skill — long-form text → atomic-thought split
- /daily skill + _shared/capture-pipeline.md extraction
- Title-driven filename slug for /note (closes #61)

### Changed

- Release v1.1.0
- Ignore .worktrees directory
- Vault cleanup: slug bug fix, lint rotation, seed onboarding
- Migrate to unified domain hub architecture (closes #46)
- Release v1.0.0
- MCP purge + v1.0.0 CHANGELOG + cli-setup examples (closes #53)
- Audit hooks, scripts, bin — CLI migration

### Documentation

- Drop Wiki Map.canvas reference from FIRST_RUN
- Reference docs rewrite — cli-setup.md, drop MCP/REST path
- Add cli.md — empirical Obsidian CLI contract

### Fixed

- Atomic CLI verbs to stop bullet-loss in /daily (PR1 of #98)
- Make dead-link check deterministic via lint-scan.sh
- Register commands directory in manifest
- Replace whole-file prepend with section-aware splice for index updates
