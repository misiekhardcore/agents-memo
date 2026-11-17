# Contributing

Guide for developing agents-memo: setup, validation gates, and the PR process.

## Development setup

**Prerequisites:** Node.js >= 22.19 (see `engines` in package.json) and pnpm. Obsidian 1.12.7+ with the CLI binary on your `PATH` is required for the full smoke suite (`pnpm run test:smoke`); `cli-smoke.sh` skips when Obsidian is not reachable. The e2e suite runs in Docker (`tests/e2e/Dockerfile`) with Obsidian bundled in the image, so it needs no local install.

```bash
pnpm install          # Install dependencies + husky pre-commit hook
pnpm run build        # Compile extensions to dist/ (tsup)
```

Dev loop: edit TypeScript in `extensions/`, skills, or scripts; run `pnpm run build` after TS changes; then validate with the gates below. Smoke tests run against a scratch vault through the real Obsidian CLI, so register a vault first (`obsidian register vault=...`, see `_shared/setup.md`).

## Validation

|Command|Purpose|
|-|-|
|`pnpm run build`|Compile TypeScript extensions to `dist/`|
|`pnpm run test`|Run smoke + regression tests|
|`pnpm run lint`|ESLint check|
|`pnpm run format`|Prettier check|
|`pnpm run typecheck`|TypeScript type-check|
|`pnpm run check`|All gates (lint + format + typecheck + test)|
|`pnpm run fix`|Auto-fix lint + format|

Markdown has its own gates via `bin/minify-md` (compacts tables, blank lines, frontmatter):

```bash
pnpm run format:md:check   # Check markdown formatting
pnpm run format:md:fix     # Auto-fix markdown formatting
```

`pnpm run check` is the full gate - run it before pushing. The pre-commit hook runs `lint-staged`: ESLint + Prettier on staged TS/JS/JSON, minify-md on staged MD.

## PR process

1. Branch from `main`: `feature/<name>` for features, `fix/<name>` for bug fixes.
2. Commit with conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`), e.g. `fix(ci): pin node version`.
3. Run `pnpm run check` and `pnpm run format:md:check` before pushing.
4. Open the PR against `main` and describe the change and test results in the body.
5. CI gates the PR: e2e (Docker smoke), format (markdown), and regression (lint + format + typecheck, build, tests) workflows. The release workflow runs manually from the Actions tab (`workflow_dispatch`), not on PRs.

CHANGELOG.md is generated from commit messages via git-cliff at release time by the release workflow (`orhun/git-cliff-action`; `pnpm run changelog` is the local equivalent), so write commits that read well in a changelog.
