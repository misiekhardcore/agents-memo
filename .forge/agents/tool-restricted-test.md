---
id: tool-restricted-test
role: tool-restricted-test
tools:
  - read:src/**
  - read:packages/**
  - read:*.md
  - read:*.json
  - grep:src/**
  - grep:packages/**
  - ls:src/**
  - ls:packages/**
  - ls:.
  - bash:git *
  - bash:npm *
  - write:src/**
  - edit:src/**
  - find:src/**
ephemeral: true
---
# Tool-Restricted Test Agent

Test-only agent spec used by the tool pattern restriction end-to-end test.

## Restrictions

|Tool|Input field|Restriction|
|-|-|-|
|bash|`command`|Only `git *` and `npm *`|
|write|`path`|Only `src/**`|
|grep|`path`|Only `src/**` and `packages/**`|
|read|`path`|`src/**`, `packages/**`, `*.md`, `*.json`|
|edit|`path`|Only `src/**`|
|find|`path`|Only `src/**`|
|ls|`path`|`src/**`, `packages/**`, `.`|

Calls to any of these tools with inputs outside the allowed patterns
are blocked by the tool-restrictions interceptor.

Do not use this spec in production flows.
