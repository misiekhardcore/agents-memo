import type { BuiltinProvider } from "@earendil-works/pi-ai/compat";
import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { expandTilde, isBoolean, isCount, isString, NestedKeyValidator } from "./helpers";
import { getRuntime } from "./runtime";

// ─── Settings ─────────────────────────────────────────────────────────────────
interface ProjectMemoryConfig {
  enabled: boolean;
  maxLearningsPerReflection: number;
  maxCoreItems: number;
  globalEnabled: boolean;
  maxGlobalItems: number;
  promotionThreshold: number;
  reflectUntouchedRuns: boolean;
}

interface MemoryInjectionConfig {
  sessionStart: boolean;
  reInjectOnCompact: boolean;
  digestBudgetChars: number;
  projectCoreTop: number;
  globalCoreTop: number;
}

interface PageCandidacyConfig {
  threshold: number;
}

interface ReflectModelConfig {
  provider: BuiltinProvider;
  id: string;
}

export interface AgentsMemoConfig {
  vaultPath?: string;
  bootstrapReadHot?: "always" | "on-demand" | "never";
  bootstrapReadIndex?: "always" | "on-demand" | "never";
  autoCommit?: boolean;
  // Opt-in: push the vault repo to its remote after auto-commit. Never force-pushes.
  autoPush?: boolean;
  projectMemory?: ProjectMemoryConfig;
  reflectModel?: ReflectModelConfig;
  fallbackToDefaultModel?: boolean;
  memoryInjection?: MemoryInjectionConfig;
  pageCandidacy?: PageCandidacyConfig;
  // Jaccard bigram similarity threshold for /memo-wiki compact-core.
  similarityThreshold?: number;
  // Auto-compact the project core on session_shutdown when the number of
  // near-duplicate pairs at or above this threshold exceeds 0.
  autoCompactThreshold?: number;
}

const PROJECT_MEMORY_SPEC: Record<keyof ProjectMemoryConfig, NestedKeyValidator> = {
  enabled: isBoolean,
  maxLearningsPerReflection: isCount,
  maxCoreItems: isCount,
  globalEnabled: isBoolean,
  maxGlobalItems: isCount,
  promotionThreshold: isCount,
  reflectUntouchedRuns: isBoolean,
};

const REFLECT_MODEL_SPEC: Record<keyof ReflectModelConfig, NestedKeyValidator> = {
  provider: isString,
  id: isString,
};

const MEMORY_INJECTION_SPEC: Record<keyof MemoryInjectionConfig, NestedKeyValidator> = {
  sessionStart: isBoolean,
  reInjectOnCompact: isBoolean,
  digestBudgetChars: isCount,
  projectCoreTop: isCount,
  globalCoreTop: isCount,
};

const PAGE_CANDIDACY_SPEC: Record<keyof PageCandidacyConfig, NestedKeyValidator> = {
  threshold: isCount,
};

export const PROJECT_MEMORY_DEFAULTS: ProjectMemoryConfig = {
  enabled: true,
  maxLearningsPerReflection: 5,
  maxCoreItems: 20,
  globalEnabled: true,
  maxGlobalItems: 20,
  promotionThreshold: 2,
  reflectUntouchedRuns: true,
};

export const DEFAULT_MEMORY_INJECTION: MemoryInjectionConfig = {
  sessionStart: true,
  reInjectOnCompact: true,
  digestBudgetChars: 800,
  projectCoreTop: 5,
  globalCoreTop: 5,
};

export const DEFAULT_PAGE_CANDIDACY: PageCandidacyConfig = {
  threshold: 3,
};

export const DEFAULT_SIMILARITY_THRESHOLD = 0.7;
export const DEFAULT_AUTO_COMPACT_THRESHOLD = 0.85;
export const MERGE_FUZZY_THRESHOLD = 0.65;

// Exported for the smoke test (pi only invokes the default export).
export function readPiSettings(cwd?: string): AgentsMemoConfig {
  const files = [
    join(homedir(), ".pi", "agent", "settings.json"),
    join(cwd ?? process.cwd(), ".pi", "settings.json"),
  ];
  const merged: AgentsMemoConfig = {};
  const projectMemory: Partial<ProjectMemoryConfig> = {};
  const reflectModel: Partial<ReflectModelConfig> = {};
  const memoryInjection: Partial<MemoryInjectionConfig> = {};
  const pageCandidacy: Partial<PageCandidacyConfig> = {};
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(f, "utf-8"));
      const block = parsed?.agentsMemo;
      if (!block || typeof block !== "object") continue;
      if (typeof block.vaultPath === "string" && merged.vaultPath === undefined)
        merged.vaultPath = block.vaultPath;
      if (
        (block.bootstrapReadHot === "always" ||
          block.bootstrapReadHot === "on-demand" ||
          block.bootstrapReadHot === "never") &&
        merged.bootstrapReadHot === undefined
      ) {
        merged.bootstrapReadHot = block.bootstrapReadHot;
      }
      if (
        (block.bootstrapReadIndex === "always" ||
          block.bootstrapReadIndex === "on-demand" ||
          block.bootstrapReadIndex === "never") &&
        merged.bootstrapReadIndex === undefined
      ) {
        merged.bootstrapReadIndex = block.bootstrapReadIndex;
      }
      if (typeof block.autoCommit === "boolean" && merged.autoCommit === undefined)
        merged.autoCommit = block.autoCommit;
      if (typeof block.autoPush === "boolean" && merged.autoPush === undefined)
        merged.autoPush = block.autoPush;
      if (
        typeof block.similarityThreshold === "number" &&
        isFinite(block.similarityThreshold) &&
        block.similarityThreshold >= 0 &&
        block.similarityThreshold <= 1 &&
        merged.similarityThreshold === undefined
      ) {
        merged.similarityThreshold = block.similarityThreshold;
      }
      if (
        typeof block.autoCompactThreshold === "number" &&
        isFinite(block.autoCompactThreshold) &&
        block.autoCompactThreshold >= 0 &&
        block.autoCompactThreshold <= 1 &&
        merged.autoCompactThreshold === undefined
      ) {
        merged.autoCompactThreshold = block.autoCompactThreshold;
      }
      if (
        typeof block.fallbackToDefaultModel === "boolean" &&
        merged.fallbackToDefaultModel === undefined
      ) {
        merged.fallbackToDefaultModel = block.fallbackToDefaultModel;
      }
      // Nested blocks: per-key first-wins at the nested level too.
      mergeNestedBlock(projectMemory, block.projectMemory, PROJECT_MEMORY_SPEC);
      mergeNestedBlock(reflectModel, block.reflectModel, REFLECT_MODEL_SPEC);
      mergeNestedBlock(memoryInjection, block.memoryInjection, MEMORY_INJECTION_SPEC);
      mergeNestedBlock(pageCandidacy, block.pageCandidacy, PAGE_CANDIDACY_SPEC);
    } catch {
      // missing or unparseable - skip
    }
  }
  // Defaults for keys the merge left undefined - never overwrite user values.
  merged.projectMemory = {
    enabled: projectMemory.enabled ?? PROJECT_MEMORY_DEFAULTS.enabled,
    maxLearningsPerReflection:
      projectMemory.maxLearningsPerReflection ?? PROJECT_MEMORY_DEFAULTS.maxLearningsPerReflection,
    maxCoreItems: projectMemory.maxCoreItems ?? PROJECT_MEMORY_DEFAULTS.maxCoreItems,
    globalEnabled: projectMemory.globalEnabled ?? PROJECT_MEMORY_DEFAULTS.globalEnabled,
    maxGlobalItems: projectMemory.maxGlobalItems ?? PROJECT_MEMORY_DEFAULTS.maxGlobalItems,
    promotionThreshold:
      projectMemory.promotionThreshold ?? PROJECT_MEMORY_DEFAULTS.promotionThreshold,
    reflectUntouchedRuns:
      projectMemory.reflectUntouchedRuns ?? PROJECT_MEMORY_DEFAULTS.reflectUntouchedRuns,
  };
  // No hardcoded defaults - reflectModel must be explicitly configured in settings.json
  if (typeof reflectModel.provider === "string" && typeof reflectModel.id === "string") {
    merged.reflectModel = { provider: reflectModel.provider, id: reflectModel.id };
  }
  merged.memoryInjection = {
    sessionStart: memoryInjection.sessionStart ?? DEFAULT_MEMORY_INJECTION.sessionStart,
    reInjectOnCompact:
      memoryInjection.reInjectOnCompact ?? DEFAULT_MEMORY_INJECTION.reInjectOnCompact,
    digestBudgetChars:
      memoryInjection.digestBudgetChars ?? DEFAULT_MEMORY_INJECTION.digestBudgetChars,
    projectCoreTop: memoryInjection.projectCoreTop ?? DEFAULT_MEMORY_INJECTION.projectCoreTop,
    globalCoreTop: memoryInjection.globalCoreTop ?? DEFAULT_MEMORY_INJECTION.globalCoreTop,
  };
  merged.pageCandidacy = {
    threshold: pageCandidacy.threshold ?? DEFAULT_PAGE_CANDIDACY.threshold,
  };
  merged.similarityThreshold = merged.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  merged.autoCompactThreshold = merged.autoCompactThreshold ?? DEFAULT_AUTO_COMPACT_THRESHOLD;
  merged.bootstrapReadHot = merged.bootstrapReadHot ?? "always";
  merged.bootstrapReadIndex = merged.bootstrapReadIndex ?? "on-demand";
  merged.autoCommit = merged.autoCommit ?? true;
  merged.autoPush = merged.autoPush ?? false;
  merged.fallbackToDefaultModel = merged.fallbackToDefaultModel ?? false;

  return merged;
}

// Parity with resolve-vault.sh tiers 3/4: Claude Code settings fall back after
// pi settings and CWD discovery, keyed by pluginConfigs[*agents-memo*]. The
// exists + isDirectory gate lives here (not in the caller) so a stale
// vault_path in settings.local.json falls through to a valid settings.json,
// matching resolve-vault.sh's per-file gate. Within a file, later valid
// entries win here — intentionally diverging from bash's head -1, which gates
// the whole file on its first matching entry. Exported for the smoke test (pi
// only invokes the default export).
export function readClaudeVaultPath(): string | null {
  for (const f of [
    join(homedir(), ".claude", "settings.local.json"),
    join(homedir(), ".claude", "settings.json"),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(f, "utf-8"));
      const pluginConfigs = parsed?.pluginConfigs;
      if (!pluginConfigs || typeof pluginConfigs !== "object") continue;
      for (const [key, val] of Object.entries(pluginConfigs)) {
        const options = (val as { options?: { vault_path?: unknown } })?.options;
        if (key.includes("agents-memo") && typeof options?.vault_path === "string") {
          const expanded = expandTilde(options.vault_path);
          if (existsSync(expanded) && statSync(expanded).isDirectory()) {
            return expanded;
          }
          // stale path in this file — keep scanning lower tiers
        }
      }
    } catch {
      // missing or unparseable - skip
    }
  }
  return null;
}

// Per-key first-wins merge for one nested config block: keys defined in the
// global file win, the project file fills only keys left undefined, and
// values are type-gated so malformed settings never leak through. Shared by
// all nested blocks so the merge semantics can never diverge between them.
function mergeNestedBlock<T extends object>(
  merged: Partial<T> | undefined,
  block: unknown,
  spec: Record<keyof T, NestedKeyValidator>,
): Partial<T> {
  const target: Partial<T> = merged ?? {};
  if (!block || typeof block !== "object") return target;
  for (const key of Object.keys(spec) as Array<keyof T>) {
    const value = (block as Record<string, unknown>)[key as string];
    if (target[key] === undefined && spec[key](value)) {
      (target as Record<string, unknown>)[key as string] = value;
    }
  }
  return target;
}

export function ensureProjectDir(vaultPath: string, slug: string): void {
  try {
    // Same pattern as skills/daily (Step 5: mkdir -p); the obsidian CLI cannot
    // create intermediate folders for nested paths.
    getRuntime().exec(`mkdir -p "${join(vaultPath, "wiki", "projects", slug, "daily")}"`, {
      cwd: vaultPath,
      encoding: "utf-8",
      timeout: 5000,
    });
  } catch {
    // best-effort - never fail the agent loop
  }
}
