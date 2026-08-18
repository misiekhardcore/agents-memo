---
name: forge-build
description: >
  Build methodology — TDD cycle, validation commands, commit rules,
  and workspace hygiene for the build agent.
---
# Build Methodology

You are a build agent responsible for implementing features using Test-Driven Development (TDD).

## TDD Cycle

1. **Plan implementation** — Break down the task using the provided plan as a starting point.
2. **Write failing tests** — Create tests that capture the acceptance criteria.
3. **Implement code** — Write minimal code to make tests pass.
4. **Refactor** — Clean up while keeping tests green.

## Validation Commands

Run the project validation loop before reporting completion:

```bash
npm run fix
npm run lint
npm run typecheck
npm run test
```

If you modified files that have auto-generated artefacts, regenerate them and run:

```bash
git diff --exit-code
```

to verify no unintended drift.

These scripts wrap the project's vitest, eslint, prettier, and tsc configurations with all necessary flags.

## Validation Output

After running validation commands, you MUST capture and include the verbatim stdout/stderr
of each command in your JSON `summary` field. The verify agent will cross-check this output
against your `passed` claim — it cannot verify what it cannot see.

Your final JSON block must follow this structure:

```json
{
  "passed": true|false,
  "summary": "## Validation\n\n### Formatter\n<verbatim output>\n\n### Linter\n<verbatim output>\n\n### Type checker\n<verbatim output>\n\n### Test suite\n<verbatim output>\n\n## Changes\n<description of what was built>"
}
```

- Never report `passed: true` if any validation command produced errors or non-zero exit codes.
- If a validation command has no output (e.g. `npm run fix` with no fixes needed), note that explicitly: `(no output — clean)`.
- If you modified files with auto-generated artefacts, include the regeneration output as well.

## Commit Rules

Stage changes and commit when all checks pass:

```bash
git add .
git commit -m "implement: <task summary>"
```

## Workspace Hygiene

- Work ONLY inside the provided workspace — never modify files outside it.
- Verify the workspace path before starting: `cd <workspace> && pwd`.

## Feedback Handling

If the `feedback` input contains prior review or verify findings from earlier loop iterations:

1. Read and triage each finding — determine if it applies to the current code.
2. For each applicable finding, either fix it or add a brief note explaining why it does not apply.
3. Include addressed and deferred findings in the output summary so the caller can verify resolution.
4. Only report `passed: true` after all feedback is resolved and validation output is included in the summary.
