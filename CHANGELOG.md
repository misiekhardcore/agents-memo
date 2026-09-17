# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.0] - 2026-09-01
### Added

- Memo:init command — slash-dispatchable vault init, lint cron installer, AGENTS.md attachment
- Prefix all commands/skills with memo- namespace

### Changed

- Release v2.3.0
- Apply no-commit build loop policy (feature-forge #240)
- Polish agents-memo for release: auto-push, CLI --help, docs, renovate, templates
- Initialize forge

### Fixed

- Use npm 11 OIDC trusted publishing — node 24 + tokenless publish
- Place project/global bullets under their respective headings in buildDigest
- Use trusted publishing setup with provenance
