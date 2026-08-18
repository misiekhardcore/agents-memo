---
name: Feature request
about: Suggest a feature for agents-memo
title: "feat: "
labels: ["enhancement"]
body:
  - type: markdown
    attributes:
      value: |
        Thanks for suggesting a feature. See CONTRIBUTING.md for the contribution process.
  - type: textarea
    attributes:
      label: Problem / motivation
      description: What problem does this solve, or what gap does it fill?
      placeholder: "e.g. batch ingest needs a resume option for interrupted runs"
    validations:
      required: true
  - type: textarea
    attributes:
      label: Proposed solution
      description: How should the feature behave? Sketch the UX or CLI surface.
      placeholder: "e.g. add a --resume flag that skips sources already in .raw/"
    validations:
      required: true
  - type: textarea
    attributes:
      label: Alternatives considered
      description: What else did you consider, and why is the proposed approach better?
  - type: input
    attributes:
      label: Scope / impact
      description: Which areas does this touch (skills, scripts, extension)? Any migration concerns?
      placeholder: "skills/ingest, scripts/obsidian-cli.sh"
  - type: checkboxes
    attributes:
      label: Vault assumptions
      description: This project has explicit design assumptions (see AGENTS.md - agent-only access, single-user, git-backed, file-per-page). Features violating them must be challenged.
      options:
        - label: I have read the vault assumptions in AGENTS.md and this feature respects them (or argues why they should change)
---
