# Per-Project Memory — Phase 2 Implementation Plan

Status: Implemented — 2026-08-07
Design: `docs/per-project-memory.md` §9 (authoritative — read it first)
Baseline: main @ 8323c68 (phase 1 merged)

Implements the phase-2 missing pieces only: global memory, token-lean digest injection, promotion sweep, page candidacy. Phase-1 code is the foundation; this plan lists deltas.

## Scope

|In|Out|
|-|-|
|Three-bucket reflection (`global` array)|Monthly synthesis (§9.8, still deferred)|
|`wiki/global-core.md` engine|Daily-notes revisit (§9.8)|
|Digest injection (session start + compact)|pi-self-learning removal (process decision)|
|`reflectUntouchedRuns` gate|resolve-config.sh keys (no shell consumers)|
|Promotion sweep + bootstrap||
|Page candidacy (Option B)||
|Config surface + tests||

## Pending decisions (confirmed 2026-08-07 — no longer open)

1. `reflectUntouchedRuns` default `true` — every agent_end reflects (cost: ~1-3s flash subprocess per run). Both paths implemented; flag flips it. ✅ confirmed
2. Sweep triggers: `session_shutdown` + on-demand `/wiki promote-global` command. ✅ confirmed (both)
3. Page candidacy applies to global core only (project cores keep plain bullets). ✅ confirmed
4. pi-self-learning: user removes the plugin once the phase-2 gaps are closed (comparison window may be short or skipped). ✅ confirmed

## Implementation order (each step independently testable)

### Step 1 — Config surface (`extensions/agents-memo.ts`)

Extend the phase-1 pattern (per-key first-wins merge + `??` defaults):

```typescript
interface ProjectMemoryConfig {
  enabled: boolean;
  maxLearningsPerReflection: number;
  maxCoreItems: number;
  globalEnabled: boolean;          // default true
  maxGlobalItems: number;          // default 20
  promotionThreshold: number;      // default 2
  reflectUntouchedRuns: boolean;   // default true (pending decision 1)
}
interface MemoryInjectionConfig {
  sessionStart: boolean;           // default true
  reInjectOnCompact: boolean;      // default true
  digestBudgetChars: number;       // default 800
  projectCoreTop: number;          // default 5
  globalCoreTop: number;           // default 5
}
interface PageCandidacyConfig {
  threshold: number;               // default 3
}
// AgentsMemoConfig += memoryInjection?: MemoryInjectionConfig; pageCandidacy?: PageCandidacyConfig
```

AC: new keys merge global→project first-wins; defaults apply only to undefined keys; existing phase-1 behavior unchanged when config absent.

### Step 2 — Reflection engine: three buckets

- `buildReflectionSystemPrompt(maxItems)`: append global instructions ("global = learnings reusable across projects: design patterns, non-trivial bug fixes, architecture decisions. Write them generically, no project identifiers.")
- `Reflection` interface: `{ mistakes: string[]; fixes: string[]; global?: string[] }`
- `parseReflectionJson`: accept `global` array; validity = any of the three non-empty (relax the current mistakes+fixes requirement)
- `serializeMessages`, subprocess spawn: unchanged

AC: prompt contains global instructions; parser extracts all three buckets; a `{global:[...]}`-only response is valid.

### Step 3 — Global core engine

- `normalizeKey`: additionally strip `[[wikilinks]]` so a promoted bullet with a `[[page]]` link still dedups against raw reflection text
- `parseCoreFile`: strip `<!--candidate-->` marker alongside the score marker
- `renderGlobalCore(dateStr, learnings, threshold)`: frontmatter `type: global-core`, `# Global Learnings`, single `## High-value learnings` section; bullets render `<!--score:N-->` and `<!--candidate-->` when `score >= threshold`
- `updateGlobalCore(vaultPath, dateStr, reflection, maxGlobalItems, candidacyThreshold)`: read `wiki/global-core.md` (create if missing via same ensureProjectDir-style path — file lives at wiki root, no project dir needed), merge `reflection.global` into learnings, dedup/score/cap, overwrite via obsidian CLI

AC: pure functions round-trip (parse→render→parse); candidate marker appears at threshold; score still increments through a wikilink-bearing bullet.

### Step 4 — agent_end gate + global write

Current handler gate is `if (!vaultPath || !touched) return;`. New logic:

```
if (!vaultPath) return;
config = readPiSettings();
if (projectMemory.enabled === false) { if (touched) legacyMarker(); return; }
if (!touched && !projectMemory.reflectUntouchedRuns) return;
// reflection path (existing) + updateGlobalCore(...) after updateProjectCore(...)
```

Legacy global daily marker stays touched-gated. `event.messages` empty check unchanged.

AC: untouched run reflects when `reflectUntouchedRuns=true`, skips when false; legacy marker only on touched; global core written on every reflected run.

### Step 5 — Digest injection (replaces per-scope injection)

- `buildDigest(vaultPath, slug, config): string | null` — read project core + global core, `parseCoreFile`, take top `projectCoreTop`/`globalCoreTop` by score, truncate combined to `digestBudgetChars`, append candidates line ("Page candidates: N (score ≥ threshold) — promote via /save or ask the agent") + pointer line ("Full memory on demand: /query or obsidian search")
- `before_agent_start` 4th handler: replace project-core-only injection with digest injection (`customType: "agents-memo-memory-digest"`, `display: false`); keep slug cache for compact
- `session_compact`: re-inject fresh digest (same customType)
- Inject nothing when both cores missing/empty
- Remove the old `agents-memo-project-core` customType usage (update smoke tests)

AC: digest contains top-N of both cores, respects budget, candidate count correct; injection once per session + once per compact; empty vault → no injection.

### Step 6 — Promotion sweep

- `sweepPromoteGlobal(vaultPath, threshold): { promoted: number }` — readdir `wiki/projects/*/`, parse each core.md learnings, normalize keys, count across projects, merge entries with count >= `promotionThreshold` into `wiki/global-core.md` (verbatim, `<!--from:slugA,slugB-->` provenance comment), overwrite
- Pure helper `findCrossProjectEntries(projects: Record<slug, string[]>, threshold): string[]` for unit tests
- Triggers: `session_shutdown` (when globalEnabled) + registered pi command `/wiki promote-global` (`pi.registerCommand`)
- First run = bootstrap (no special casing)

AC: entry in 2 projects promotes once; entry in 1 project stays; provenance comment present; idempotent re-run (no double promotion); command invocable.

### Step 7 — Tests

`tests/extension-smoke.mjs` new/updated sections:
- reflection prompt + parser with global bucket (incl. global-only response)
- global core: creation, merge, score increment, cap, candidate marker at threshold, wikilink dedup (normalizeKey)
- agent_end: writes global core; untouched run reflects with `reflectUntouchedRuns=true` (settings variant), skips with false
- digest: project+global top-N, budget truncation, candidates line; injected at before_agent_start and session_compact (customType `agents-memo-memory-digest`); empty vault → none
- sweep: cross-project promote, threshold gate, idempotency, provenance
- config: new nested blocks merge first-wins + defaults
- extend stateful `projectFiles` mock to cover `wiki/global-core.md`

`pi-settings-tier.sh`: no changes (no new shell keys).

AC: `make test` all tiers green; `tsc --noEmit --strict`; `format:check`.

### Step 8 — Docs + rollout

- Flip `docs/per-project-memory.md` status: phase 2 implemented
- CHANGELOG via `make changelog` at release
- Live sanity: with the extension installed, verify (a) digest appears at session start, (b) a reflection writes `wiki/global-core.md`, (c) `/wiki promote-global` runs without error
- Then the pi-self-learning comparison window opens (§9.8 exit criterion)

## Validation per step

`npx tsc --noEmit --strict` + targeted smoke section after each step; full `make test` + `format:check` at the end of Steps 4, 5, 6.

## Risks / gotchas

- `spawnSync` reflection blocks agent_end (~1-3s) — unchanged from phase 1, now per run when `reflectUntouchedRuns` (cost decision 1)
- Digest budget: truncation must not cut a bullet mid-way (truncate to last complete bullet ≤ budget)
- Sweep readdir: skip non-directories and files without parseable learnings; never touch `.raw/`, `_attachments/`
- Session_shutdown sweep must not fire during extension reload churn (guard: only when a vault resolved this session)
- Command name collision: verify no existing `/wiki` subcommand named `promote-global`
