# Per-Project Memory — Design & Implementation Plan

Status: Implemented — 2026-08-06 (phase 1; monthly synthesis deferred to phase 2)
Scope: add project-scoped memory to agents-memo vault with pi-self-learning-like structure

## 1. Current state (what exists in PR #185)

| Feature | Status | Detail |
|---|---|---|
| agent_end handler | ✅ implemented | Writes static marker to global `daily/YYYY-MM-DD.md` |
| session_shutdown handler | ✅ implemented | Same static marker |
| before_agent_start injection | ✅ implemented | INIT.md, hot.md (if always), index.md (if always) |
| Per-project storage | ❌ missing | Everything goes to global vault |
| LLM-distilled reflection | ❌ missing | Static marker only — no `complete()` call |
| Core learnings (CORE.md) | ❌ missing | No ranked/deduped durable learnings |
| Monthly summaries | ❌ missing | No synthesis across daily entries |

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

- Do NOT replicate pi-self-learning's redistill mechanism (cross-project genericization)
- Do NOT implement scored decay (age-based ranking) — simpler: just cap + recency sort
- Do NOT change the global daily note behavior for sessions without projectMemory
- Do NOT add per-project vault paths — single vault, project-scoped pages within it
