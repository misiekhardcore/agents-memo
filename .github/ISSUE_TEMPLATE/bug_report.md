---
name: Bug report
about: Report a bug in agents-memo
title: "bug: "
labels: ["bug"]
body:
  - type: markdown
    attributes:
      value: |
        Thanks for taking the time to report a bug. See CONTRIBUTING.md for project context.
  - type: textarea
    attributes:
      label: Description
      description: What happened, and what did you expect to happen?
      placeholder: e.g. /memo-ingest hangs after fetching the page, no error is shown
    validations:
      required: true
  - type: textarea
    attributes:
      label: Steps to reproduce
      description: Minimal steps that trigger the issue.
      placeholder: |
        1. Run `pi` in a project with a configured vault
        2. Invoke /memo-ingest on a URL
        3. Observe the failure
    validations:
      required: true
  - type: input
    attributes:
      label: Environment
      description: pi version, Node version, Obsidian version, OS
      placeholder: pi 0.84.x, Node 22.x, Obsidian 1.12.7+, Linux
  - type: textarea
    attributes:
      label: Relevant skills / commands
      description: Which skill or CLI verb was involved (e.g. /memo-ingest, obsidian read)?
      placeholder: /memo-ingest, obsidian read path=wiki/hot.md
  - type: textarea
    attributes:
      label: Logs / output
      description: Paste any error messages or relevant output.
      render: shell
  - type: checkboxes
    attributes:
      label: Validation
      options:
        - label: I checked the existing issues for a duplicate
        - label: I reproduced this with a minimal example
---

