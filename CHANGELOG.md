# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.4.0] - 2026-09-17
### Added

- Update orchestrators and flows to integrate memo- skills for persistent memory

### Changed

- Release v2.4.0
- Feat/agents memo fallback
- Small cleanup
- Prettier format fixes for extension TS files
- Re-recordable 3-scene demo (ingest/query/save vhs tapes + runtime setup)

### Fixed

- Npm test passes with hot-cache-guard skip and vitest config
- Eslint no-require-imports in persistVaultPath()
- Stream safety + Claude→DeepSeek model mapping
- Obsidian-cli passes vault= before the verb — CLI ignores it after
- Splice index entries after first matching heading; lint duplicate headings
