# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-08-11
### Added

- Deterministic core compaction with Porter stemming and bigram Jaccard similarity
- "learning" working indicator during reflection
- Global cross-project memory + token-lean digest injection (phase 2)
- Per-project memory — LLM-distilled reflections under wiki/projects/<slug>
- Migrate from Claude Code plugin to pi package

### Changed

- Release v2.2.0
- Remove Claude Code leftovers
- Remove plan docs
- Prepare repo as releasable pi extension package
- Cleanup

### Fixed

- Drop tests that need Obsidian running or deleted hooks
- Remove unnecessary escape characters in system prompt strings
- Close process.cwd() gap for git worktrees
- Truthful auto-commit notify + bounded in-process reflection
- Quote when_to_use values in skill frontmatter so YAML parses
- Guard wiki/hot.md against silent 0-byte corruption
