# Per-Project Memory — Design & Implementation Plan

Status: Phase 1 implemented (2026-08-06); phase 2 implemented (2026-08-07)
Scope: project-scoped + global memory in agents-memo vault with pi-self-learning-like structure

## 1. Current state (what exists in PR #185)

|Feature|Status|Detail|
|-|-|-|
|agent_end handler|✅ implemented|Writes static marker to global `daily/YYYY-MM-DD.md`|
|session_shutdown handler|✅ implemented|Same static marker|
|before_agent_start injection|✅ implemented|INIT.md, hot.md (if always), index.md (if always)|
|Per-project storage|❌ missing|Everything goes to global vault|
|LLM-distilled reflection|❌ missing|Static marker only — no `complete()` call|
|Core learnings (CORE.md)|❌ missing|No ranked/deduped durable learnings|
|Monthly summaries|❌ missing|No synthesis across daily entries|

## 2. Target vault structure

```
wiki/projects/<project-slug>/
├── core.md                   # Top-ranked durable learnings (like CORE.md)
├── daily/
│   └── YYYY-MM-DD.md         # Session reflections for this project
└── monthly/
    └── YYYY-MM.md            # Monthly synthesis (idempotent upsert)
```

Project slug derived from:
1. `git remote get-url origin` → parse `owner/repo` → use `repo`
2. Fallback: `basename(ctx.cwd)` (sanitized: lowercase, spaces → hyphens)

## 3. Settings additions

```jsonc
// ~/.pi/agent/settings.json → agentsMemo block
{
  "projectMemory": {
    "enabled": true,              // false = no per-project pages
    "maxLearningsPerReflection": 5, // per agent_end reflection
    "maxCoreItems": 20             // cap for core.md
  },
  "reflectModel": {
    "provider": "deepseek",
    "id": "deepseek-v4-flash"     // cheap model for reflection subprocess
  }
}
```

`resolve-config.sh` extended with `project_memory_enabled` → `projectMemory.enabled` mapping.

## 4. API constraint: no `complete()` at pi@0.83

Verified: `@earendil-works/pi-ai` at pi@0.83.0 exports neither `complete` nor `getModel`. The `dist/index.js` file has zero matches for either symbol.

**Solution**: spawn `pi --mode json -p --no-session --model <reflectModel>` subprocess with a reflection prompt — same pattern memo_dispatch uses for sub-agents. This is testable (mock spawnSync), uses existing auth/config, and avoids depending on an API that doesn't exist.

## 5. Extension changes

### 5.1 Config interface

```typescript
interface ProjectMemoryConfig {
  enabled: boolean;
  maxLearningsPerReflection: number;
  maxCoreItems: number;
}

interface ReflectModelConfig {
  provider: string;
  id: string;
}

interface AgentsMemoConfig {
  // ... existing fields ...
  projectMemory?: ProjectMemoryConfig;
  reflectModel?: ReflectModelConfig;
}
```

Settings merge: read `agentsMemo.projectMemory` and `agentsMemo.reflectModel` from pi settings JSON (global → project merge, per-key first-wins).

### 5.2 Project slug derivation

```typescript
function getProjectSlug(cwd: string): string {
  // Try git remote
  try {
    const url = execSync("git remote get-url origin", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
    // Extract repo name: "git@github.com:owner/repo.git" or "https://github.com/owner/repo"
    const match = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1].split("/")[1].toLowerCase();
  } catch { /* no git */ }
  // Fallback to directory name
  return basename(cwd).toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}
```

### 5.3 agent_end — LLM-distilled reflection (replaces static marker)

```typescript
pi.on("agent_end", (_event, ctx) => {
  const config = readPiSettings();
  const vaultPath = getVaultPath();
  const touched = vaultTouched;
  vaultTouched = false;
  if (!vaultPath || !touched) return;
  if (config.projectMemory?.enabled === false) {
    // Fall back to legacy static marker for global daily
    appendGlobalDailyReflection(vaultPath, "session ended - vault was modified");
    return;
  }

  const slug = getProjectSlug(ctx.cwd);
  const dateStr = new Date().toISOString().slice(0, 10);
  const timeStr = new Date().toTimeString().slice(0, 5);

  // Gather last N messages for reflection context
  const messages = getBranchMessages(ctx, 8);
  if (messages.length === 0) return;

  // Spawn pi subprocess for LLM reflection (no complete() API available)
  spawnReflectionSubprocess(config, messages, (reflection) => {
    if (!reflection) return;
    // Write reflection to wiki/projects/<slug>/daily/YYYY-MM-DD.md
    appendProjectDailyEntry(vaultPath, slug, dateStr, timeStr, reflection);
    // Update core.md: merge + dedup + cap
    updateProjectCore(vaultPath, slug, reflection, config.projectMemory.maxCoreItems);
  });
});
```

**Reflection prompt** (sent to pi subprocess):
```
You are a coding session mistake-prevention reflection engine.
Focus on what went wrong and how it was fixed.
Return STRICT JSON only: {"mistakes":["..."],"fixes":["..."]}
- Keep each array short (max N).
- Prefer specific, actionable, prevention-oriented points.
- Rewrite project-specific details into generic rules.

<conversation>
... last 8 messages ...
</conversation>
```

### 5.4 before_agent_start — project core.md injection

Add as 4th handler (after INIT, hot, index):

```typescript
pi.on("before_agent_start", (_event, ctx): BeforeAgentStartEventResult | void => {
  if (!isSessionBootstrap()) return;
  const config = readPiSettings();
  if (!config.projectMemory?.enabled) return;
  const vaultPath = getVaultPath();
  if (!vaultPath) return;
  const slug = getProjectSlug(ctx.cwd);
  const core = execObsidianRead(vaultPath, `wiki/projects/${slug}/core.md`);
  if (!core) return;
  return {
    message: {
      customType: "agents-memo-project-core",
      content: `[agents-memo: project memory for ${slug}]\n${core}`,
      display: false,
    },
  };
});
```

Also add re-injection in session_compact (same pattern as hot/index).

### 5.5 core.md management

**Initial creation**: if `wiki/projects/<slug>/core.md` doesn't exist, create it with:
```markdown
---
type: project-core
project: <slug>
created: <date>
updated: <date>
---

# Project Learnings — <slug>

## High-value learnings
- (none yet)

## Watch-outs
- (none yet)
```

**Update on reflection**: merge reflection fixes/learnings into core.md:
1. Read existing core.md, parse `## High-value learnings` and `## Watch-outs` bullet lists
2. Reflection `fixes` go to learnings list; `mistakes` go to watch-outs (prefixed "Avoid: ")
3. Deduplicate by normalized key (lowercase, strip whitespace)
4. Increment hit count + score for existing entries; add new entries with score=1
5. Sort by score desc, cap at maxCoreItems, render + overwrite

**Monthly synthesis** (session_shutdown, optional): if today crosses a new month:
1. Read all daily entries for the previous month from `wiki/projects/<slug>/daily/`
2. Spawn pi subprocess with month-summary prompt
3. Write/overwrite `wiki/projects/<slug>/monthly/YYYY-MM.md`

## 6. Test plan

1. **extension-smoke.mjs**: add sections for:
   - Project slug derivation (git remote, no-git fallback, sanitization)
   - agent_end: spawns reflection subprocess with correct prompt, writes to project daily path, updates core.md
   - agent_end: falls back to legacy global marker when projectMemory.enabled=false
   - before_agent_start: injects project core.md when projectMemory.enabled
   - session_compact: re-injects project core.md
   - core.md: creation, dedup, cap, score increment

2. **Unit tests for core.md merging**: parse/dedup/cap logic as pure functions

3. **pi-settings-tier.sh**: add cases for projectMemory keys (enabled, maxLearningsPerReflection)

## 7. Implementation order

1. Extend `AgentsMemoConfig` interface + `readPiSettings()` in `extensions/agents-memo.ts`
2. Add `getProjectSlug()` function
3. Replace static `appendDailyReflection` with `spawnReflectionSubprocess` + `appendProjectDailyEntry`
4. Add `updateProjectCore()` (create/merge/dedup/cap)
5. Add `before_agent_start` handler for project core.md injection
6. Add `session_compact` re-injection for project core.md
7. Add monthly synthesis in `session_shutdown` (optional, phase 2)
8. Extend `resolve-config.sh` for new keys
9. Update `extension-smoke.mjs` with new test sections
10. Run `make test` → all existing + new assertions green

## 8. Non-goals

- Do NOT replicate pi-self-learning's redistill mechanism as a separate pass — phase 2 replaces this with inline genericization at reflection time (three-bucket output, §9.3)
- Do NOT implement scored decay (age-based ranking) — simpler: just cap + recency sort
- Do NOT change the global daily note behavior for sessions without projectMemory
- Do NOT add per-project vault paths — single vault, project-scoped pages within it
- Do NOT inject memory per prompt / per turn (token-heavy anti-pattern, §9.4)

## 9. Phase 2 — Global memory & token-lean injection (design)

Status: implemented 2026-08-07 (three-bucket reflection, global-core engine, digest injection, promotion sweep + `/wiki promote-global`, page candidacy).

### 9.1 Goals

1. Cross-project memory: learnings reusable between projects (design patterns, non-trivial bugs/fixes, architecture decisions — e.g. the several Next.js projects share a lot)
2. Token-lean injection: memory reaches the model at session start + compaction only; NEVER per prompt/turn
3. On-demand retrieval as the deep-memory channel: `/query`, memory-search agent, obsidian CLI search

### 9.2 Research grounding (2026-07/08 surveys; vault notes: context-hygiene, long-term-memory-alternatives)

- Tiered memory is the consensus architecture (MemGPT/Letta, CALMem, MEMTIER): small always-in working block + external tiers pulled in on demand
- Per-prompt full-memory injection is the documented anti-pattern: "lost in the middle" (Liu et al.) — buried facts are functionally invisible; instruction budget ~150-200 rules; Anthropic measured 49% → 74% accuracy with lazy-loaded tools vs loading everything upfront
- Retrieval quality dominates over write sophistication (UCSD 2026: 14-23 pts retrieval vs 3-8 pts write strategy); raw chunk storage with zero LLM calls matches expensive extraction
- Ablation budgets (MEMTIER): optimal injection = k=2-5 entries, 300-600 tokens; CALMem MOIM: scale injection down as context fills, suppress at ≥80% fill
- Vault research (memsearch): the community-validated wiki pattern is "no permanent context tax" — nothing injected except on-demand hits

### 9.3 Three-bucket reflection (inline genericization)

Reflection prompt gains a third array. Mistakes/fixes merge into the project core; `global` items merge into `wiki/global-core.md`.

```json
{"mistakes":["..."],"fixes":["..."],"global":["..."]}
```

Prompt addition: "global = learnings reusable across projects: design patterns, non-trivial bug fixes, architecture decisions. Write them generically, no project identifiers." This replaces the phase-1 non-goal on redistill: genericization happens at reflection time (one cheap model call), not as a separate pass.

### 9.4 Injection design (token-lean)

Event cadence verified in pi runtime (agent-session.js: turnIndex resets at agent_start, increments per turn_end):

|Event|Frequency|Verdict|
|-|-|-|
|turn_start / turn_end|every LLM call (multiple per user prompt)|never inject|
|agent_start / agent_end|once per user prompt|never inject|
|before_agent_start (first prompt)|once per session|inject digest|
|session_compact|once per compaction|re-inject digest|

**Digest** (injected at session start + compaction, `display: false`):

```
[agents-memo memory]
## Project learnings (<slug>)
- top 5 from wiki/projects/<slug>/core.md (by score)
## Global learnings
- top 5 from wiki/global-core.md (by score)

Page candidates: N (score ≥ pageCandidacyThreshold) — promote via /save or ask the agent
Full memory on demand: /query or obsidian search.
```

Budget: ~600-800 chars total (cores only — no daily/monthly content in the digest). Config-capped (`digestBudgetChars`, `projectCoreTop`, `globalCoreTop`). Deliberately NO perPrompt option — the anti-pattern.

### 9.5 Global store

`wiki/global-core.md` — top-level machine-compiled artifact, sibling of hot.md/index.md, NOT a page category:

|Artifact|Author|Maintained by|Examples|
|-|-|-|-|
|Wiki pages|human/agent|human/agent (ingest, save)|concepts/, entities/, sources/|
|Registry|both|skills (index-section-insert)|wiki/index.md|
|Rolling state|agent|hot-cache protocol|wiki/hot.md|
|Cores (phase 1/2)|reflection engine|machine: merge/dedup/score/cap|wiki/projects/<slug>/core.md, wiki/global-core.md|

Cores are the compiled output of the reflection pipeline — score-ranked, deduped, capped bullet lists of learnings, purpose-built for (a) small enough to inject, (b) ranked by hit count. They feed the wiki, they don't replace it: a global learning that deserves a full write-up is promoted into the normal flow (concepts/<pattern>.md + index.md + hot.md) and the core bullet becomes a `[[pattern-page]]` pointer.

Same engine as project cores: parse/merge/dedup/score/cap is slug-agnostic; global is a reserved scope (no slug collision — file lives at wiki/global-core.md, not wiki/projects/global/).

### 9.6 Emergent cross-project promotion + page candidacy

**Promotion sweep** (deterministic, no LLM): periodic (session_shutdown or on-demand command) scan of all wiki/projects/*/core.md, normalize entries, promote entries present in ≥2 projects into wiki/global-core.md with a provenance note (`promotionThreshold`, default 2). Verbatim-only by design — the `global` reflection bucket (§9.3) is the semantic channel; the sweep catches only near-identical repeats. First run seeds global-core from the existing corpus (no backfill machinery).

**Page candidacy** (Option B — auto-detected, agent-created): a global-core bullet whose score crosses `pageCandidacyThreshold` (default 3 = "stable truth") is rendered with a `<!--candidate-->` marker; the digest (§9.4) reports the candidate count as a nudge. The agent then creates the page via the existing authoring flow (/save or direct page creation: structure, links, index.md entry, hot.md touch) and the bullet becomes a `[[pattern-page]]` pointer. Detection is deterministic and free; creation stays human/agent-initiated to preserve curation quality — the extension never spawns page-writing LLM calls (vault research: ingest-time compilation is the wiki pattern; write-time sophistication buys little).

### 9.7 Settings additions (all optional)

```jsonc
"agentsMemo": {
  "projectMemory": {
    "globalEnabled": true,
    "maxGlobalItems": 20,
    "promotionThreshold": 2,
    "reflectUntouchedRuns": true   // reflect when vault NOT touched (gap: coding sessions never reflect today)
  },
  "memoryInjection": {
    "sessionStart": true,
    "reInjectOnCompact": true,
    "digestBudgetChars": 800,
    "projectCoreTop": 5,
    "globalCoreTop": 5
  },
  "pageCandidacy": {
    "threshold": 3   // score at which a global bullet becomes a page candidate
  }
}
```

### 9.8 Follow-ups (deferred)

- Monthly synthesis (phase 1 §5.5) — still deferred
- Daily notes system underused (write-only sink): revisit as separate effort — on-demand /query is the intended consumption channel
- Pattern pages on demand: /save or /ingest promotes a core bullet into a full concept page
- pi-self-learning: user removes the plugin once the phase-2 gaps are closed (confirmed 2026-08-07)

### 9.9 End-to-end flow (who creates what, when)

```
SESSION START
  before_agent_start (extension): read project core + global core
    → build DIGEST (~600-800 chars) → inject hidden message (once per session)

DURING SESSION
  deep memory is ON DEMAND ONLY: /query, memory-search agent, obsidian search
  (searches dailies + cores + pages = episodic + semantic tiers)
  NO automatic injection beyond the digest (§9.4 anti-pattern)

RUN END
  agent_end (extension):
    gate: vault touched (or always — pending reflectUntouchedRuns decision)
    last 8 messages → spawn reflection subprocess (deepseek-v4-flash)
    → returns {mistakes, fixes, global}
    extension writes 3 artifacts via obsidian CLI:
      1. daily/YYYY-MM-DD.md       append  (EPISODIC record)
      2. projects/<slug>/core.md   merge mistakes/fixes (SEMANTIC, project)
      3. global-core.md            merge global items (SEMANTIC, cross-project)
      each: dedup + score + cap, overwrite

COMPACTION
  session_compact (extension): re-inject FRESH digest (cores may have changed)

SESSION END / PERIODIC
  session_shutdown or /wiki command (extension, deterministic, no LLM):
    promotion sweep: entries present in ≥2 projects/*/core.md
      → promoted verbatim into global-core.md (+ provenance)
    FIRST RUN = bootstrap: seeds global-core from the existing corpus

ANY TIME (existing flow, human or agent)
  /save, /ingest → full wiki pages (concepts/, entities/, sources/)
    + index.md entry + hot.md touch
  global-core bullet deserving depth → concepts/<pattern>.md page,
    bullet becomes a [[pattern-page]] pointer
```

Artifact-author table:

|Artifact|Created by|When|Method|
|-|-|-|-|
|Digest (injected, not a file)|extension before_agent_start / session_compact|session start + each compaction|read cores, truncate to budget, hidden message|
|projects/<slug>/daily/YYYY-MM-DD.md|extension agent_end|each reflected run|subprocess reflection → create-or-append|
|projects/<slug>/core.md|extension agent_end|each reflected run|fixes→learnings, mistakes→watch-outs; dedup/score/cap → create overwrite|
|global-core.md|extension agent_end + promotion sweep|each reflected run + sweep|merge global bucket; sweep promotes cross-project repeats|
|concepts/, entities/, sources/ pages|agent/human via skills|on demand|/save, /ingest + index + hot (existing pipeline)|
|hot.md, index.md|agents|on demand|existing hot-cache / index protocols|
|monthly/YYYY-MM.md|extension (future)|month boundary|subprocess month-summary over dailies|

Self-reinforcing loop: reflection → cores rank up → next session's digest carries top lessons → agent behaves differently → future reflections confirm/refine → scores climb. Dailies = raw evidence trail; cores = compiled rules; pages = deep knowledge; digest = the only thing that touches the prompt.

Nuances:

1. First session in a new project: no project core → digest = global core + pointer; the first reflection run creates the project subtree
2. The reflection subprocess is the only LLM writer; the extension is a compiler (merge/dedup/rank — deterministic); skills write pages; the sweep moves verbatim entries, writes nothing new
3. Pages are auto-DETECTED (score ≥ pageCandidacyThreshold → <!--candidate--> marker + digest nudge) but never auto-WRITTEN — creation stays human/agent-initiated via the existing /save flow; cores never spawn concept pages by themselves
