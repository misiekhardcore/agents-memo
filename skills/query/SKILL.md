---
name: memo-query
description: Answer questions from wiki vault. Reads strategically, synthesizes with citations, files answers back.
when_to_use: Use when the user asks a question, or to retrieve information from the wiki.
model: opus
effort: high
user-invocable: true
argument-hint: "[question]"
allowed-tools: Agent Bash Read
---
Read strategically, answer precisely, file answers back so knowledge compounds. Three modes: Quick, Standard, Deep.

## I/O
- Input: User question.
- Output: Synthesized answer with citations, optional filed wiki page.

## Process
1. **Quick**: Read `wiki/hot.md`. If it answers, respond. Read `wiki/index.md`. If found in index summary, respond. Otherwise → Standard.
2. **Standard**: Read hot.md → tag-match leaves via `obsidian search` → hub path via `wiki/domains/` → fallback to index. Read candidates cheapest-first. Synthesize with citations.
3. **Deep**: Read all relevant domain hubs → pull backlinks per candidate → group >5 and dispatch `agents/memory-gather.md` per cluster (parallel). Synthesize comprehensive answer. Offer web search if coverage thin.
4. **File**: Always file the answer. See `references/response-formatting.md` for filing format.

## Rules
- Quick mode: do not open individual pages or call `obsidian backlinks`.
- Standard stops at the earliest step that answers the question.
- Gaps: see `references/fallback.md`. Reading heuristics: see `references/reading-heuristics.md`.
- Before spawning agents: `cd "${VAULT_ROOT}" && pwd`.
