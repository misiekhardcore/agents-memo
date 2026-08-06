---
name: autoresearch
description: Autonomous research loop. Searches the web, synthesizes findings, and files structured wiki pages.
when_to_use: Does NOT answer questions from existing wiki — use /query for that. Starts fresh web research on a topic.
model: opus
effort: high
user-invocable: true
allowed-tools: Agent Bash Read WebFetch WebSearch
---
Iterative web searches on a topic, synthesize findings, file everything into wiki pages. Karpathy's autoresearch pattern.

## I/O
- Input: Research topic or question.
- Output: Wiki pages (sources, concepts, entities, synthesis, trail), index/log/hot-cache updates.

## Process
1. **Init**: Read `_shared/research-program.md` for constraints. Read hot.md + index.md for existing coverage.
2. **Round 1**: Broad web search → fetch sources → fan-out `agents/memory-source-synth.md` per source (parallel).
3. **Round 2**: Identify gaps → fan-out `agents/memory-research-round.md` per gap (parallel).
4. **Synthesize**: Write synthesis page + trail page. See `references/research-and-filing.md` for schemas.
5. **File**: Update `wiki/index.md`, append to `wiki/log.md`, overwrite `wiki/hot.md`.

## Rules
- Verify CWD before spawning agents: `cd "${VAULT_ROOT}" && pwd`.
- Respect limits from `_shared/research-program.md` (max rounds, max pages, confidence scoring).
- Pass explicit seed-brief context variables to agents — agents do not re-research what the orchestrator provides.
- Respect constraints over completeness; note gaps in open questions.
