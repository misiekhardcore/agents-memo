/**
 * agents-memo pi extension
 *
 * Pi port of the Claude Code hooks in hooks/hooks.json. Handles:
 *   - tool_call: rewrites ${MEMO_PLUGIN_PWD} and leading `obsidian` calls to
 *     scripts/obsidian-cli.sh, blocks daily/*.md overwrites (issue #98), and
 *     blocks direct read/write/edit on vault paths.
 *   - before_agent_start / session_compact: injects _shared/INIT.md, the
 *     hot cache / index when bootstrap config says "always", and the
 *     project+global memory digest (per-project-memory.md §9.4).
 *   - tool_execution_end: guards wiki/hot.md against silent 0-byte corruption.
 *   - agent_settled: auto-commits vault git changes and notifies.
 *   - agent_end: distills the run into project + global cores (reflection).
 *   - session_shutdown: end-of-session daily marker + cross-project
 *     promotion sweep into wiki/global-core.md (§9.6); /wiki promote-global
 *     triggers the same sweep on demand.
 *
 * API surface: @earendil-works/pi-coding-agent (installed pi@0.83.0). Validated
 * with `tsc --noEmit --strict` against the installed package's dist types.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentEndEvent,
  AgentSettledEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
// In-process model calls for the session reflection (agent_end). The pi
// runtime resolves this bare specifier to its bundled compat entrypoint via
// the extension-loader import map; the peer dependency only supplies types
// and the hermetic smoke-test resolution.
import { complete, getModel } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";

// ─── Plugin root ──────────────────────────────────────────────────────────────
// The extension lives at <pluginRoot>/extensions/agents-memo.ts; the plugin
// root is one level up. jiti loads this module as ESM, so import.meta.url is
// the authoritative location even when the package is installed elsewhere.
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  provider: string;
  id: string;
}

interface AgentsMemoConfig {
  vaultPath?: string;
  bootstrapReadHot?: "always" | "on-demand" | "never";
  bootstrapReadIndex?: "always" | "on-demand" | "never";
  autoCommit?: boolean;
  projectMemory?: ProjectMemoryConfig;
  reflectModel?: ReflectModelConfig;
  memoryInjection?: MemoryInjectionConfig;
  pageCandidacy?: PageCandidacyConfig;
}

const PROJECT_MEMORY_DEFAULTS: ProjectMemoryConfig = {
  enabled: true,
  maxLearningsPerReflection: 5,
  maxCoreItems: 20,
  globalEnabled: true,
  maxGlobalItems: 20,
  promotionThreshold: 2,
  reflectUntouchedRuns: true,
};

const DEFAULT_MEMORY_INJECTION: MemoryInjectionConfig = {
  sessionStart: true,
  reInjectOnCompact: true,
  digestBudgetChars: 800,
  projectCoreTop: 5,
  globalCoreTop: 5,
};

const DEFAULT_PAGE_CANDIDACY: PageCandidacyConfig = {
  threshold: 3,
};

const REFLECT_MODEL_DEFAULTS: ReflectModelConfig = {
  provider: "deepseek",
  id: "deepseek-v4-flash",
};

// Per-key validators for each nested block (type-gated merge). Declared as
// typed constants so the merge helper infers T from the merged argument,
// keeping the value types intact.
type NestedKeyValidator = (v: unknown) => boolean;

const isBoolean: NestedKeyValidator = (v) => typeof v === "boolean";
// Numeric keys are counts/budgets/thresholds: NaN, ±Infinity (JSON.parse
// accepts 1e999 → Infinity) and negatives would silently degrade digest
// budgets, caps and thresholds, so they are rejected and fall back to
// defaults instead of being honored.
const isCount: NestedKeyValidator = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isString: NestedKeyValidator = (v) => typeof v === "string";

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

// Per-key first-wins, matching resolve-vault.sh / resolve-config.sh tier
// 0a/0b: for each key the global file (~/.pi/agent/settings.json) wins; the
// project file (.pi/settings.json) only fills keys the global file leaves
// undefined. A global block that defines only autoCommit must not shadow a
// project vaultPath. projectMemory / reflectModel / memoryInjection /
// pageCandidacy are merged the same way at their own sub-key level, then
// defaults are applied with nullish coalescing so explicit user values are
// never overwritten.

// Per-key first-wins merge for one nested config block: keys defined in the
// global file win, the project file fills only keys left undefined, and
// values are type-gated so malformed settings never leak through. Shared by
// all nested blocks so the merge semantics can never diverge between them.
function mergeNestedBlock<T extends object>(merged: Partial<T> | undefined, block: unknown, spec: Record<keyof T, NestedKeyValidator>): Partial<T> {
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

// Exported for the smoke test (pi only invokes the default export).
export function readPiSettings(): AgentsMemoConfig {
  const files = [
    join(homedir(), ".pi", "agent", "settings.json"),
    join(process.cwd(), ".pi", "settings.json"),
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
      if (typeof block.vaultPath === "string" && merged.vaultPath === undefined) merged.vaultPath = block.vaultPath;
      if ((block.bootstrapReadHot === "always" || block.bootstrapReadHot === "on-demand" || block.bootstrapReadHot === "never") && merged.bootstrapReadHot === undefined) {
        merged.bootstrapReadHot = block.bootstrapReadHot;
      }
      if ((block.bootstrapReadIndex === "always" || block.bootstrapReadIndex === "on-demand" || block.bootstrapReadIndex === "never") && merged.bootstrapReadIndex === undefined) {
        merged.bootstrapReadIndex = block.bootstrapReadIndex;
      }
      if (typeof block.autoCommit === "boolean" && merged.autoCommit === undefined) merged.autoCommit = block.autoCommit;
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
    maxLearningsPerReflection: projectMemory.maxLearningsPerReflection ?? PROJECT_MEMORY_DEFAULTS.maxLearningsPerReflection,
    maxCoreItems: projectMemory.maxCoreItems ?? PROJECT_MEMORY_DEFAULTS.maxCoreItems,
    globalEnabled: projectMemory.globalEnabled ?? PROJECT_MEMORY_DEFAULTS.globalEnabled,
    maxGlobalItems: projectMemory.maxGlobalItems ?? PROJECT_MEMORY_DEFAULTS.maxGlobalItems,
    promotionThreshold: projectMemory.promotionThreshold ?? PROJECT_MEMORY_DEFAULTS.promotionThreshold,
    reflectUntouchedRuns: projectMemory.reflectUntouchedRuns ?? PROJECT_MEMORY_DEFAULTS.reflectUntouchedRuns,
  };
  merged.reflectModel = {
    provider: reflectModel.provider ?? REFLECT_MODEL_DEFAULTS.provider,
    id: reflectModel.id ?? REFLECT_MODEL_DEFAULTS.id,
  };
  merged.memoryInjection = {
    sessionStart: memoryInjection.sessionStart ?? DEFAULT_MEMORY_INJECTION.sessionStart,
    reInjectOnCompact: memoryInjection.reInjectOnCompact ?? DEFAULT_MEMORY_INJECTION.reInjectOnCompact,
    digestBudgetChars: memoryInjection.digestBudgetChars ?? DEFAULT_MEMORY_INJECTION.digestBudgetChars,
    projectCoreTop: memoryInjection.projectCoreTop ?? DEFAULT_MEMORY_INJECTION.projectCoreTop,
    globalCoreTop: memoryInjection.globalCoreTop ?? DEFAULT_MEMORY_INJECTION.globalCoreTop,
  };
  merged.pageCandidacy = {
    threshold: pageCandidacy.threshold ?? DEFAULT_PAGE_CANDIDACY.threshold,
  };
  return merged;
}

function expandTilde(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

// ─── Project slug ─────────────────────────────────────────────────────────────
// Slug derived from the git origin repo name, falling back to the sanitized
// basename of the working directory. Lowercase; every non-alphanumeric run
// (spaces, underscores, dots, ...) collapses to a single hyphen; edge hyphens
// trimmed; never empty ("unknown").
function sanitizeSlug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

// Exported for the smoke test.
export function getProjectSlug(cwd: string): string {
  try {
    const url = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // "git@github.com:owner/repo.git" or "https://github.com/owner/repo" → owner/repo
    const match = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) return sanitizeSlug(match[1].split("/")[1]);
  } catch {
    // no git remote - fall through to directory name
  }
  return sanitizeSlug(basename(cwd));
}

function projectCoreRel(slug: string): string {
  return `wiki/projects/${slug}/core.md`;
}

function projectDailyRel(slug: string, dateStr: string): string {
  return `wiki/projects/${slug}/daily/${dateStr}.md`;
}

function ensureProjectDir(vaultPath: string, slug: string): void {
  try {
    // Same pattern as skills/daily (Step 5: mkdir -p); the obsidian CLI cannot
    // create intermediate folders for nested paths.
    execSync(`mkdir -p "${join(vaultPath, "wiki", "projects", slug, "daily")}"`, {
      cwd: vaultPath,
      encoding: "utf-8",
      timeout: 5000,
    });
  } catch {
    // best-effort - never fail the agent loop
  }
}

// Escape a string for a double-quoted shell argument whose value round-trips
// through the obsidian CLI content= handling: literal \n sequences become
// newlines in the vault file. Real newlines are converted to \n so multi-line
// content survives as a single shell argument.
function escapeShellContent(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    // $ and backticks are live in double-quoted shell args (command
    // substitution): model-generated reflection text must never reach the
    // shell unescaped (verified: $(echo PWNED) executes without these).
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/\r?\n/g, "\\n");
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
  for (const f of [join(homedir(), ".claude", "settings.local.json"), join(homedir(), ".claude", "settings.json")]) {
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

// Exported for the smoke test (pi only invokes the default export).
export function resolveVaultPath(): string | null {
  const config = readPiSettings();
  if (config.vaultPath) {
    const expanded = expandTilde(config.vaultPath);
    if (existsSync(expanded) && statSync(expanded).isDirectory()) {
      return expanded;
    }
  }
  // Fallback: CWD contains a wiki/ subdirectory (resolve-vault.sh tier 2).
  const cwdWiki = join(process.cwd(), "wiki");
  if (existsSync(cwdWiki) && statSync(cwdWiki).isDirectory()) {
    return process.cwd();
  }
  // Fallback: Claude Code settings (resolve-vault.sh tiers 3/4) — already
  // validated (exists + directory) inside readClaudeVaultPath.
  return readClaudeVaultPath();
}

// ─── Content cache ────────────────────────────────────────────────────────────
let initContent: string | null = null;

function getInitContent(): string {
  if (initContent !== null) return initContent;
  try {
    const raw = readFileSync(join(pluginRoot, "_shared", "INIT.md"), "utf-8");
    // INIT.md references the plugin root via ${MEMO_PLUGIN_PWD} (migrated from
    // ${CLAUDE_PLUGIN_ROOT}); both must resolve to the real path at injection
    // time, mirroring the envsubst step in hooks/hooks.json.
    initContent = raw
      .replace(/\$\{MEMO_PLUGIN_PWD\}/g, pluginRoot)
      .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot);
  } catch {
    initContent = "";
  }
  return initContent;
}

interface ObsidianReadResult {
  ok: boolean;
  content: string;
}

// Safe core read: distinguishes "file missing" from "read failed" so write
// pipelines never mistake a transient CLI failure for an empty file. The
// obsidian-cli.sh wrapper normalizes the upstream CLI's always-zero exit to
// exit 1 with `Error: File "<path>" not found.` on stdout when the target
// file is missing; that specific shape is a normal cold-start condition and
// reports as ok with empty content. Any other failure (preflight, vault
// resolution, generic CLI error) reports as not-ok and callers skip the
// write. Exported for the smoke test (pi only invokes the default export).
export function execObsidianReadSafe(vaultPath: string, relPath: string): ObsidianReadResult {
  try {
    const obsCli = join(pluginRoot, "scripts", "obsidian-cli.sh");
    const content = execSync(`bash "${obsCli}" read "path=${relPath}"`, {
      cwd: vaultPath,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, content };
  } catch (err) {
    const out = String((err as { stdout?: unknown })?.stdout ?? "");
    if (/Error: File .* not found/.test(out)) return { ok: true, content: "" };
    return { ok: false, content: "" };
  }
}

function execObsidianRead(vaultPath: string, relPath: string): string | null {
  const result = execObsidianReadSafe(vaultPath, relPath);
  return result.ok ? result.content : null;
}

// ─── Bypass allowlist for direct vault I/O ─────────────────────────────────────
// Mirrors the exceptions in hooks/block-direct-vault-io.sh: binary attachments,
// canvas files, the manifest, and lint admin artifacts cannot go through the
// CLI's text verbs.
// Most-specific rules first: .raw/.manifest.json (read/write/edit) must be
// checked before the read-only .raw/** rule, mirroring the bash hook's
// Write|Edit branch where only the manifest (not .raw/*) is allowed.
const VAULT_IO_BYPASS: Array<{ pattern: RegExp; tools: string[] }> = [
  { pattern: /^\.raw\/\.manifest\.json$/, tools: ["read", "write", "edit"] },
  { pattern: /^\.raw\/.*/, tools: ["read"] },
  { pattern: /^_attachments\/.*/, tools: ["read", "write", "edit"] },
  { pattern: /\.canvas$/, tools: ["read", "write", "edit"] },
  { pattern: /^wiki\/meta\/lint-data-.*\.json$/, tools: ["write", "edit"] },
];

function isVaultBypassed(vaultRelativePath: string, toolName: string): boolean {
  for (const entry of VAULT_IO_BYPASS) {
    if (entry.pattern.test(vaultRelativePath)) {
      return entry.tools.includes(toolName.toLowerCase());
    }
  }
  return false;
}

// Realpath both sides with a fallback for missing paths. Parity with the bash
// hook's `realpath -ms` (symlinks preserved, existence not required): walk up
// to the longest existing ancestor, realpath it, and re-append the unresolved
// tail, so a NEW-file write inside a symlinked vault still hits containment
// instead of escaping via the un-resolved symlink prefix.
function realpathOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    let ancestor = p;
    const tail: string[] = [];
    for (;;) {
      try {
        return join(realpathSync(ancestor), ...tail);
      } catch {
        const parent = dirname(ancestor);
        if (parent === ancestor) return resolve(p);
        tail.unshift(basename(ancestor));
        ancestor = parent;
      }
    }
  }
}

// Normalized containment check: returns the realpath-normalized (file, vault)
// pair when filePath is inside vaultPath, or null. Separator boundary so
// /home/u/wiki does not match /home/u/wiki2 (parity with `realpath -ms` +
// prefix check in the bash hook). The vault root itself is allowed through,
// matching block-direct-vault-io.sh whose `"$VAULT"/*` literal-prefix checks
// never match the root. One realpath walk per side serves both the block
// decision and the bypass-allowlist rel path.
function vaultContainedPair(filePath: string, vaultPath: string): { abs: string; vaultAbs: string } | null {
  const abs = realpathOrResolve(resolve(process.cwd(), filePath));
  const vaultAbs = realpathOrResolve(resolve(vaultPath));
  const prefix = vaultAbs.endsWith("/") ? vaultAbs : vaultAbs + "/";
  return abs.startsWith(prefix) ? { abs, vaultAbs } : null;
}

// ─── Write-verb detection (touched tracking) ─────────────────────────────────
// Write-verb class mirrors hooks/log-obsidian-calls.sh's auto-commit verbs
// (create, append, prepend, create-or-append, property:set, property:remove,
// eval) plus `overwrite` (a create flag; harmless to over-match).
const WRITE_VERB_RE = /\b(create|create-or-append|append|prepend|overwrite|property:set|property:remove|eval)\b/;

// Extract the obsidian verb positionally, mirroring log-obsidian-calls.sh's
// VERB extraction: for routed commands the first token AFTER the LAST wrapper
// occurrence that has a follower (bash's greedy `s/.*obsidian-cli\.sh
// [^[:space:]]* //` backtracks past a trailing wrapper with no verb); for raw
// commands, strip leading KEY=val assignments (bash sed #2) and take the
// token after a leading `obsidian`. This keeps `obsidian read ... | grep
// append` from counting as a write while compound commands (read && append)
// still detect the last write verb.
function extractVerb(cmd: string): string | null {
  const joined = cmd
    .replace(/\\\r?\n/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ content=[^\s]*/g, "")
    .replace(/ template=[^\s]*/g, "");
  const tokens = joined.split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].includes("obsidian-cli.sh") && tokens[i + 1] !== undefined) {
      return tokens[i + 1];
    }
  }
  let idx = stripEnvPrefix(tokens);
  if (tokens[idx] === "obsidian") return tokens[idx + 1] ?? null;
  return null;
}

// Index of the first non-env-prefix token (strips leading KEY=val
// assignments, mirroring log-obsidian-calls.sh's CMD_NOENV stripping). Shared
// by extractVerb and isObsidianRouted so the two never diverge.
function stripEnvPrefix(tokens: string[]): number {
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++;
  return idx;
}

// True when the command routes through obsidian — via the rewritten wrapper
// path, or as a raw command with a leading `obsidian` token after stripping
// leading KEY=val assignments (log-obsidian-calls.sh's CMD_NOENV gate).
function isObsidianRouted(cmd: string): boolean {
  if (cmd.includes("obsidian-cli.sh")) return true;
  const tokens = cmd.split(/\s+/);
  return tokens[stripEnvPrefix(tokens)] === "obsidian";
}

// ─── Session state ────────────────────────────────────────────────────────────
let vaultTouched = false; // vault touched during the current agent run
let sessionTouched = false; // vault touched at any point this session
let vaultPathCached: string | null = null;
// toolCallId → bash command (tool_execution_end has no input field; the guard
// needs the command text to know whether hot.md was involved).
const bashCommands = new Map<string, string>();

function getVaultPath(): string | null {
  if (vaultPathCached === null) {
    vaultPathCached = resolveVaultPath();
  }
  return vaultPathCached;
}

// ─── Daily overwrite guard (issue #98) ────────────────────────────────────────
// Parity with hooks/obsidian-cli-rewrite.sh: checked on the command BEFORE the
// leading-obsidian rewrite, already-routed commands (mentioning obsidian-cli)
// pass through (the bash hook early-exits on them), `obsidian` must appear
// before `create` (bash glob `*obsidian*create*`), and the daily path class
// mirrors the bash grep `path=("?)daily/[^[:space:]"]*\.md`.
function isDailyOverwrite(command: string): boolean {
  if (command.includes("obsidian-cli")) return false;
  const obsIdx = command.indexOf("obsidian");
  const createIdx = command.indexOf("create");
  if (obsIdx === -1 || createIdx === -1 || createIdx < obsIdx) return false;
  const hasDailyPath = /path=("?)daily\/[^\s"]*\.md/.test(command);
  const hasOverwrite = /overwrite=true|overwrite=1|overwrite(\s|$)/.test(command);
  return hasDailyPath && hasOverwrite;
}

// ─── Reflection engine ────────────────────────────────────────────────────────
// Per-project memory (docs/per-project-memory.md): on agent_end, distill the
// last messages into a mistake/fix reflection via an in-process complete()
// call and file it under wiki/projects/<slug>/ (daily + core.md). The call is
// bounded by withTimeout so a slow/hung model can never block the session
// (the previous spawned-pi-subprocess design froze the session for up to 60s
// and could hang forever when the provider child survived SIGTERM while
// holding the stdout pipe).

interface Reflection {
  mistakes: string[];
  fixes: string[];
  global?: string[];
}

// Minimal structural view of the messages pi passes to agent_end. Avoids a
// direct import from the nested @earendil-works/pi-ai transitive dep; only the
// fields the serializer reads are declared.
interface ReflectionMessage {
  role: string;
  content: unknown;
  toolName?: string;
}

// Compact text transcript of the last messages, bounded per part and overall
// (keep the tail - the reflection focuses on what just happened).
function serializeMessages(messages: ReflectionMessage[]): string {
  const MAX_PART = 500;
  const MAX_TOTAL = 8000;
  const lines: string[] = [];
  for (const msg of messages) {
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = (msg.content as Array<{ type?: string; text?: string; name?: string; arguments?: unknown }>)
        .map((part) => {
          if (part?.type === "text") return part.text ?? "";
          if (part?.type === "toolCall") return `[tool_call ${part.name}] ${JSON.stringify(part.arguments)}`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    text = text.trim();
    if (!text) continue;
    const truncated = text.length > MAX_PART ? text.slice(0, MAX_PART) + "…" : text;
    if (msg.role === "toolResult") lines.push(`[tool ${msg.toolName ?? "?"}] ${truncated}`);
    else lines.push(`${msg.role === "assistant" ? "Assistant" : "User"}: ${truncated}`);
  }
  const joined = lines.join("\n");
  return joined.length > MAX_TOTAL ? joined.slice(-MAX_TOTAL) : joined;
}

// Exported for the smoke test (pi only invokes the default export).
export function buildReflectionSystemPrompt(maxItems: number): string {
  return [
    "You are a coding session mistake-prevention reflection engine.",
    "Focus on what went wrong and how it was fixed.",
    'Return STRICT JSON only: {"mistakes":["..."],"fixes":["..."],"global":["..."]}',
    `- Keep each array short (max ${maxItems}).`,
    "- Prefer specific, actionable, prevention-oriented points.",
    "- Rewrite project-specific details into generic rules.",
    '- Put anything reusable across projects in "global": design patterns, non-trivial bug fixes, architecture decisions.',
    "- Write global items generically - no project names, paths, or other project-specific identifiers.",
  ].join("\n");
}

// Exported for the smoke test (pi only invokes the default export).
export function parseReflectionJson(text: string): Reflection | null {
  const parse = (candidate: string): Reflection | null => {
    try {
      const parsed = JSON.parse(candidate) as { mistakes?: unknown; fixes?: unknown; global?: unknown };
      const mistakes = Array.isArray(parsed.mistakes) ? parsed.mistakes.filter((m): m is string => typeof m === "string") : [];
      const fixes = Array.isArray(parsed.fixes) ? parsed.fixes.filter((m): m is string => typeof m === "string") : [];
      const global = Array.isArray(parsed.global) ? parsed.global.filter((m): m is string => typeof m === "string") : [];
      // Valid when any bucket is non-empty: a global-only reflection (pure
      // reusable learnings, nothing went wrong) is a legitimate outcome.
      if (mistakes.length === 0 && fixes.length === 0 && global.length === 0) return null;
      return { mistakes, fixes, global };
    } catch {
      return null;
    }
  };
  const trimmed = text.trim();
  // Strip markdown fences if the model wrapped the JSON.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const parsed = parse(fenced[1].trim());
    if (parsed) return parsed;
  }
  // Bare {...} block in otherwise-prose output.
  const bare = trimmed.match(/\{[\s\S]*\}/);
  return bare ? parse(bare[0]) : parse(trimmed);
}

// Bounded race: rejects after ms (aborting the controller, if given) so a
// hung model call can never block the session. Exported for the smoke test.
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string, controller?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller?.abort();
          reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const REFLECTION_MODEL_TIMEOUT_MS = 60_000;
const REFLECTION_MAX_TOKENS = 900;

type RequestAuth = { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string };

// Resolve the reflection model + request auth: configured reflectModel first
// (via the session's model registry, with a getModel fallback), then the
// session's current model. Best-effort — null skips the reflection silently.
async function pickReflectionModel(config: AgentsMemoConfig, ctx: ExtensionContext): Promise<{
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
} | null> {
  const wanted = config.reflectModel ?? REFLECT_MODEL_DEFAULTS;
  const registry = (ctx.modelRegistry ?? {}) as unknown as {
    find?: (provider: string, id: string) => Model<Api> | undefined;
    getApiKeyAndHeaders?: (model: Model<Api>) => Promise<RequestAuth>;
  };
  const findModel = (provider: string, id: string): Model<Api> | undefined =>
    registry.find?.(provider, id) ??
    (getModel as unknown as (p: string, i: string) => Model<Api> | undefined)(provider, id);
  const candidates = [findModel(wanted.provider, wanted.id), ctx.model].filter(
    (m): m is Model<Api> => !!m && typeof (m as { provider?: unknown }).provider === "string" && typeof (m as { id?: unknown }).id === "string",
  );
  for (const model of candidates) {
    try {
      const auth = await registry.getApiKeyAndHeaders?.(model);
      if (auth?.ok === true) return { model, apiKey: auth.apiKey, headers: auth.headers };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// Distill the run into a reflection via an in-process complete() call wrapped
// in withTimeout — asynchronous and strictly bounded, so a slow or hung model
// can never freeze the session (the pre-fix spawned subprocess froze the
// event loop for up to 60s and could hang indefinitely). Best-effort: any
// failure yields null and the caller silently skips.
async function runReflection(config: AgentsMemoConfig, ctx: ExtensionContext, messages: ReflectionMessage[]): Promise<Reflection | null> {
  try {
    const picked = await pickReflectionModel(config, ctx);
    if (!picked) return null;
    const maxItems = config.projectMemory?.maxLearningsPerReflection ?? PROJECT_MEMORY_DEFAULTS.maxLearningsPerReflection;
    const conversation = serializeMessages(messages);
    const prompt = `${buildReflectionSystemPrompt(maxItems)}\n\n<conversation>\n${conversation}\n</conversation>`;
    const controller = new AbortController();
    const response = await withTimeout(
      complete(
        picked.model,
        { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
        { apiKey: picked.apiKey, headers: picked.headers, maxTokens: REFLECTION_MAX_TOKENS, signal: controller.signal },
      ),
      REFLECTION_MODEL_TIMEOUT_MS,
      "reflection model call",
      controller,
    );
    const text = (response.content as Array<{ type?: string; text?: string }>)
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim();
    return text ? parseReflectionJson(text) : null;
  } catch {
    return null; // timed out, no auth, network failure — best-effort
  }
}

function appendProjectDailyEntry(
  vaultPath: string,
  slug: string,
  dateStr: string,
  timeStr: string,
  reflection: Reflection,
): void {
  try {
    ensureProjectDir(vaultPath, slug);
    const obsCli = join(pluginRoot, "scripts", "obsidian-cli.sh");
    const template =
      "---\\ntype: project-daily\\nproject: " + slug +
      "\\ndate: " + dateStr + "\\ncreated: " + dateStr + "\\nupdated: " + dateStr +
      "\\n---\\n\\n## Reflections\\n";
    const mistakes = reflection.mistakes.map((m) => `- ${m}`).join("\\n") || "- (none)";
    const fixes = reflection.fixes.map((f) => `- ${f}`).join("\\n") || "- (none)";
    const content =
      `## ${timeStr} Reflection\\n` +
      `### Mistakes\\n${mistakes}\\n` +
      `### Fixes\\n${fixes}\\n`;
    execSync(
      `bash "${obsCli}" create-or-append ` +
        `file=${projectDailyRel(slug, dateStr)} ` +
        `template="${escapeShellContent(template)}" ` +
        `content="${escapeShellContent(content)}"`,
      { cwd: vaultPath, encoding: "utf-8", timeout: 10000 },
    );
  } catch {
    // best-effort - never fail the agent loop
  }
}

// ─── core.md management (pure, unit-testable) ────────────────────────────────
interface CoreEntry {
  text: string;
  score: number;
  // Cross-project provenance (promotion sweep, §9.6): slugs of the project
  // cores an entry was promoted from. Render-side metadata like the score
  // marker — stripped from text on parse, never part of the bullet body.
  from?: string[];
}

interface ProjectCore {
  learnings: CoreEntry[];
  watchouts: CoreEntry[];
}

const SCORE_MARKER_RE = /<!--score:(\d+)-->\s*$/;
const CANDIDATE_MARKER_RE = /<!--candidate-->/g;
const FROM_MARKER_RE = /<!--from:[^>]*-->/g; // strip (normalizeKey)
const FROM_EXTRACT_RE = /<!--from:([^>]*)-->\s*/; // capture (parseCoreFile)
const WIKILINK_RE = /\[\[[^\]]*\]\]/g;

// Normalized dedup key: lowercase, whitespace collapsed. [[wikilinks]], the
// <!--candidate--> render marker and the <!--from:...--> provenance marker are
// stripped so a promoted pointer bullet still dedups against the raw
// reflection text it came from. A bullet that is nothing but a link falls
// back to its raw text so distinct pointers never collide on an empty key.
function normalizeKey(text: string): string {
  const stripped = text
    .toLowerCase()
    .replace(WIKILINK_RE, "")
    .replace(CANDIDATE_MARKER_RE, "")
    .replace(FROM_MARKER_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || text.toLowerCase().replace(/\s+/g, " ").trim();
}

// Parse a core.md document into entries. Bullets carry an invisible HTML
// score marker (<!--score:N-->); watch-out bullets are rendered with an
// "Avoid: " prefix which is stripped here so the same mistake text dedups
// across reflections.
export function parseCoreFile(text: string): ProjectCore {
  const learnings: CoreEntry[] = [];
  const watchouts: CoreEntry[] = [];
  let section: "learnings" | "watchouts" | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith("## High-value learnings")) {
      section = "learnings";
      continue;
    }
    if (line.startsWith("## Watch-outs")) {
      section = "watchouts";
      continue;
    }
    if (section && line.startsWith("- ")) {
      let body = line.slice(2).trimEnd();
      // Render-side markers (candidate, provenance, score) — never part of
      // the entry text; stripped in marker order so any layout round-trips.
      body = body.replace(CANDIDATE_MARKER_RE, "").trimEnd();
      let from: string[] | undefined;
      const fromM = body.match(FROM_EXTRACT_RE);
      if (fromM) {
        from = fromM[1].split(",").filter(Boolean);
        body = body.replace(FROM_EXTRACT_RE, "").trimEnd();
      }
      let score = 1;
      const scoreM = body.match(SCORE_MARKER_RE);
      if (scoreM) {
        score = parseInt(scoreM[1], 10) || 1;
        body = body.slice(0, scoreM.index).trimEnd();
      }
      if (section === "watchouts" && body.startsWith("Avoid: ")) body = body.slice("Avoid: ".length).trim();
      if (!body || body === "(none yet)") continue;
      const entry: CoreEntry = { text: body, score };
      if (from?.length) entry.from = from;
      (section === "learnings" ? learnings : watchouts).push(entry);
    }
  }
  return { learnings, watchouts };
}

// Merge incoming strings (or provenance-carrying promoted items) into an
// entry list: dedup by normalized key, score+1 on a hit (provenance unions),
// new entries start at 1. Sorted by score desc (stable for ties), capped at
// maxItems. Shared by the project and global cores and the promotion sweep so
// the dedup/score/cap semantics can never diverge between them.
function mergeEntries(entries: CoreEntry[], incoming: Array<string | { text: string; from?: string[] }>, maxItems: number): CoreEntry[] {
  const byKey = new Map(entries.map((e) => [normalizeKey(e.text), e]));
  for (const raw of incoming) {
    const item = typeof raw === "string" ? { text: raw } : raw;
    const text = item.text.trim();
    if (!text) continue;
    const key = normalizeKey(text);
    const existing = byKey.get(key);
    if (existing) {
      existing.score += 1;
      if (item.from?.length) {
        existing.from = [...new Set([...(existing.from ?? []), ...item.from])].sort();
      }
    } else {
      const entry: CoreEntry = { text, score: 1 };
      if (item.from?.length) entry.from = [...item.from].sort();
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, maxItems);
}

// Merge a reflection into existing entries: fixes → learnings, mistakes →
// watch-outs (rendered with an "Avoid: " prefix). Existing entries get score+1
// on a normalized-text hit; new entries start at 1. Sorted by score desc,
// capped at maxItems. No age-based decay (non-goal: simple cap + recency).
export function mergeReflection(core: ProjectCore, reflection: Reflection, maxItems: number): ProjectCore {
  return {
    learnings: mergeEntries(core.learnings, reflection.fixes, maxItems),
    watchouts: mergeEntries(core.watchouts, reflection.mistakes, maxItems),
  };
}

export function renderCoreFile(slug: string, dateStr: string, core: ProjectCore): string {
  const renderSection = (title: string, entries: CoreEntry[], isWatchout: boolean): string => {
    if (entries.length === 0) return `## ${title}\n- (none yet)\n`;
    const bullets = entries.map((e) => `- ${isWatchout ? "Avoid: " : ""}${e.text}<!--score:${e.score}-->`);
    return `## ${title}\n${bullets.join("\n")}\n`;
  };
  return (
    `---\ntype: project-core\nproject: ${slug}\ncreated: ${dateStr}\nupdated: ${dateStr}\n---\n\n` +
    `# Project Learnings — ${slug}\n\n` +
    renderSection("High-value learnings", core.learnings, false) +
    "\n" +
    renderSection("Watch-outs", core.watchouts, true)
  );
}

export function updateProjectCore(
  vaultPath: string,
  slug: string,
  dateStr: string,
  reflection: Reflection,
  maxCoreItems: number,
): void {
  try {
    ensureProjectDir(vaultPath, slug);
    const relPath = projectCoreRel(slug);
    // Read-failure guard (parity with updateGlobalCore): a transient CLI
    // failure must not be conflated with an empty store, or the accumulated
    // project corpus gets clobbered. Missing file (ok, empty content)
    // proceeds from an empty core — phase-1 happy path unchanged.
    const read = execObsidianReadSafe(vaultPath, relPath);
    if (!read.ok) return;
    const core = read.content ? parseCoreFile(read.content) : { learnings: [], watchouts: [] };
    const merged = mergeReflection(core, reflection, maxCoreItems);
    const rendered = renderCoreFile(slug, dateStr, merged);
    const obsCli = join(pluginRoot, "scripts", "obsidian-cli.sh");
    execSync(
      `bash "${obsCli}" create path=${relPath} overwrite=true content="${escapeShellContent(rendered)}"`,
      { cwd: vaultPath, encoding: "utf-8", timeout: 10000 },
    );
  } catch {
    // best-effort - never fail the agent loop
  }
}

// ─── wiki/global-core.md management ──────────────────────────────────────────
// Global core: cross-project learnings from the reflection's global bucket
// (docs/per-project-memory.md §9.5). Same engine as project cores; the file
// lives at the wiki root and carries no project slug. Bullets whose score
// reaches candidacyThreshold render a <!--candidate--> marker (page-candidacy
// nudge, §9.6); sweep-promoted bullets additionally carry a <!--from:...-->
// provenance marker. Frontmatter keeps the ORIGINAL created date — only
// updated refreshes on each merge (a clobbered created date would lose the
// store's birth record).

// The created date is extracted from the existing file before a merge so a
// re-render never stamps over it. Missing/absent frontmatter → undefined,
// and the caller falls back to today.
function extractCreatedDate(content: string): string | undefined {
  const m = content.match(/^created:\s*(\S+)/m);
  return m?.[1];
}

export function renderGlobalCore(createdDate: string, updatedDate: string, learnings: CoreEntry[], candidacyThreshold: number): string {
  const renderSection = (entries: CoreEntry[]): string => {
    if (entries.length === 0) return `## High-value learnings\n- (none yet)\n`;
    const bullets = entries.map((e) => {
      const candidate = e.score >= candidacyThreshold ? "<!--candidate-->" : "";
      const provenance = e.from?.length ? `<!--from:${e.from.join(",")}-->` : "";
      return `- ${e.text}${provenance}<!--score:${e.score}-->${candidate}`;
    });
    return `## High-value learnings\n${bullets.join("\n")}\n`;
  };
  return (
    `---\ntype: global-core\ncreated: ${createdDate}\nupdated: ${updatedDate}\n---\n\n` +
    `# Global Learnings\n\n` +
    renderSection(learnings)
  );
}

// Read wiki/global-core.md (missing = empty core), merge reflection.global
// into learnings with the same dedup/score-increment/cap logic as project
// cores, render, overwrite via the obsidian CLI. Best-effort: never fail the
// agent loop.
export function updateGlobalCore(
  vaultPath: string,
  dateStr: string,
  reflection: Reflection,
  maxGlobalItems: number,
  candidacyThreshold: number,
): void {
  try {
    const relPath = "wiki/global-core.md";
    // Read-failure guard: a transient CLI failure must not be conflated with
    // an empty store, or the accumulated corpus gets clobbered by a render of
    // just this reflection. Missing file (ok, empty content) proceeds.
    const read = execObsidianReadSafe(vaultPath, relPath);
    if (!read.ok) return;
    const core = read.content ? parseCoreFile(read.content) : { learnings: [], watchouts: [] };
    const merged = mergeEntries(core.learnings, reflection.global ?? [], maxGlobalItems);
    const rendered = renderGlobalCore(extractCreatedDate(read.content) ?? dateStr, dateStr, merged, candidacyThreshold);
    const obsCli = join(pluginRoot, "scripts", "obsidian-cli.sh");
    execSync(
      `bash "${obsCli}" create path=${relPath} overwrite=true content="${escapeShellContent(rendered)}"`,
      { cwd: vaultPath, encoding: "utf-8", timeout: 10000 },
    );
  } catch {
    // best-effort - never fail the agent loop
  }
}

// ─── Promotion sweep (phase-2 §9.6) ─────────────────────────────────────────
// Cross-project promotion, deterministic (no LLM): entries that appear in
// >= promotionThreshold DISTINCT project cores are promoted verbatim into
// wiki/global-core.md with a <!--from:slugA,slugB--> provenance marker. The
// reflection engine's `global` bucket (§9.3) stays the semantic channel; the
// sweep only catches near-identical repeats across projects.
//
// Pure counting helper (exported for the smoke test) counts normalized-dedup
// occurrences per project: a text repeated twice in ONE project still counts
// once, so the threshold measures spread, not volume.

export function findCrossProjectEntries(projects: Record<string, string[]>, threshold: number): string[] {
  return collectCrossProjectEntries(projects, threshold).map((e) => e.text);
}

interface PromotedEntry {
  text: string;
  slugs: string[];
}

function collectCrossProjectEntries(projects: Record<string, string[]>, threshold: number): PromotedEntry[] {
  const byKey = new Map<string, { text: string; slugs: Set<string> }>();
  for (const [slug, entries] of Object.entries(projects)) {
    for (const raw of entries) {
      const text = raw.trim();
      if (!text) continue;
      const key = normalizeKey(text);
      const rec = byKey.get(key);
      if (rec) rec.slugs.add(slug);
      else byKey.set(key, { text, slugs: new Set([slug]) });
    }
  }
  return [...byKey.values()]
    .filter((rec) => rec.slugs.size >= threshold)
    // Deterministic order: most-spread first, then text.
    .sort((a, b) => b.slugs.size - a.slugs.size || a.text.localeCompare(b.text))
    .map((rec) => ({ text: rec.text, slugs: [...rec.slugs].sort() }));
}

// Scan wiki/projects/*/core.md (readdir = real fs; core reads go through the
// obsidian CLI like every other vault read), promote cross-project entries
// into wiki/global-core.md with provenance, overwrite via the CLI. Returns
// the number of entries newly promoted. Idempotent: entries already present
// in the global core with a provenance set covering their source projects
// are skipped (no duplicate bullets, no score inflation on re-runs).
// Best-effort: missing projects dir, read failures, or unparseable cores
// yield { promoted: 0 } and never fail the agent loop. Exported for the
// smoke test (pi only invokes the default export).
export function sweepPromoteGlobal(
  vaultPath: string,
  promotionThreshold: number,
  maxGlobalItems: number = PROJECT_MEMORY_DEFAULTS.maxGlobalItems,
): { promoted: number } {
  try {
    const projectsRoot = join(vaultPath, "wiki", "projects");
    const projects: Record<string, string[]> = {};
    for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue; // stray files (scratch.txt) never count
      const read = execObsidianReadSafe(vaultPath, projectCoreRel(entry.name));
      if (!read.ok) continue;
      const core = parseCoreFile(read.content);
      if (core.learnings.length > 0) projects[entry.name] = core.learnings.map((e) => e.text);
    }
    const candidates = collectCrossProjectEntries(projects, promotionThreshold);
    if (candidates.length === 0) return { promoted: 0 };

    const relPath = "wiki/global-core.md";
    const existing = execObsidianReadSafe(vaultPath, relPath);
    if (!existing.ok) return { promoted: 0 };
    const core = existing.content ? parseCoreFile(existing.content) : { learnings: [], watchouts: [] };
    // Skip entries whose source projects are already fully covered by the
    // existing provenance — a re-run then leaves the store byte-identical
    // instead of inflating scores.
    const byKey = new Map(core.learnings.map((e) => [normalizeKey(e.text), e]));
    const incoming: Array<{ text: string; from: string[] }> = [];
    for (const cand of candidates) {
      const existingEntry = byKey.get(normalizeKey(cand.text));
      if (existingEntry?.from && cand.slugs.every((s) => existingEntry.from?.includes(s))) continue;
      incoming.push({ text: cand.text, from: cand.slugs });
    }
    if (incoming.length === 0) return { promoted: 0 };

    const merged = mergeEntries(core.learnings, incoming, maxGlobalItems);
    const rendered = renderGlobalCore(extractCreatedDate(existing.content) ?? new Date().toISOString().slice(0, 10), new Date().toISOString().slice(0, 10), merged, DEFAULT_PAGE_CANDIDACY.threshold);
    const obsCli = join(pluginRoot, "scripts", "obsidian-cli.sh");
    execSync(
      `bash "${obsCli}" create path=${relPath} overwrite=true content="${escapeShellContent(rendered)}"`,
      { cwd: vaultPath, encoding: "utf-8", timeout: 10000 },
    );
    return { promoted: incoming.length };
  } catch {
    return { promoted: 0 };
  }
}

// ─── Digest builder ──────────────────────────────────────────────────────────
// Token-lean session-start context (design §9.4): top project + global
// learnings by score, truncated at bullet boundaries to digestBudgetChars.
// Read-only — never writes the vault. Returns null when both cores are
// empty/missing (nothing to inject) so callers skip injection entirely.
//
// Read failures are tolerated per-side (a transient CLI failure skips that
// side, not the whole digest) — the digest is read-only so there is no
// clobber risk, unlike updateGlobalCore's write pipeline.
// Exported for the smoke test (pi only invokes the default export).
export function buildDigest(vaultPath: string, slug: string, config: AgentsMemoConfig): string | null {
  const injection = config.memoryInjection ?? DEFAULT_MEMORY_INJECTION;
  const threshold = config.pageCandidacy?.threshold ?? DEFAULT_PAGE_CANDIDACY.threshold;

  const projRead = execObsidianReadSafe(vaultPath, projectCoreRel(slug));
  const globalRead = execObsidianReadSafe(vaultPath, "wiki/global-core.md");
  const projCore = projRead.ok ? parseCoreFile(projRead.content) : { learnings: [], watchouts: [] };
  const globalCore = globalRead.ok ? parseCoreFile(globalRead.content) : { learnings: [], watchouts: [] };
  // Stable score-desc sort before slicing: cores are stored score-sorted, but
  // hand-edited files must still yield the top entries deterministically.
  const byScore = (entries: CoreEntry[]): CoreEntry[] => [...entries].sort((a, b) => b.score - a.score);
  const projTop = byScore(projCore.learnings).slice(0, injection.projectCoreTop);
  const globalTop = byScore(globalCore.learnings).slice(0, injection.globalCoreTop);
  if (projTop.length === 0 && globalTop.length === 0) return null;

  // Page-candidacy nudge counts every global learning at/above the threshold
  // (the store's stable-truth pool, not just the bullets shown in the digest).
  const candidates = globalCore.learnings.filter((e) => e.score >= threshold).length;
  const header = `[agents-memo memory]\n## Project learnings (${slug})\n## Global learnings`;
  const pointer = `\n\nPage candidates: ${candidates} (score >= ${threshold}) — promote via /save or ask the agent\nFull memory on demand: /query or obsidian search.`;
  const bullets = [...projTop.map((e) => `- ${e.text}`), ...globalTop.map((e) => `- ${e.text}`)];

  // Truncate to digestBudgetChars at bullet boundaries: drop lowest-ranked
  // (last) bullets while over budget. If even the header + pointer exceed the
  // budget, all bullets go but the pointer line is kept.
  const body = (bs: string[]) => (bs.length > 0 ? `${header}\n${bs.join("\n")}` : header);
  if (body(bullets).length + pointer.length <= injection.digestBudgetChars) {
    return body(bullets) + pointer;
  }
  while (bullets.length > 0) {
    bullets.pop();
    if (body(bullets).length + pointer.length <= injection.digestBudgetChars) break;
  }
  return body(bullets) + pointer;
}

function appendDailyReflection(vaultPath: string, label: string): void {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5);
  try {
    const obsCli = join(pluginRoot, "scripts", "obsidian-cli.sh");
    const template =
      "---\\ntype: daily\\ndate: " + dateStr +
      "\\ncreated: " + dateStr + "\\nupdated: " + dateStr +
      "\\n---\\n\\n## Captures\\n";
    execSync(
      `bash "${obsCli}" create-or-append ` +
        `file=daily/${dateStr}.md ` +
        `template="${template}" ` +
        `content="- ${timeStr} ${label}"`,
      { cwd: vaultPath, encoding: "utf-8", timeout: 10000 },
    );
  } catch {
    // best-effort reflection - never fail the agent loop
  }
}

// ─── Extension entry point ────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  // ── AC5/AC6/AC7/AC12: tool_call (rewrite + block) ──────────────────────────
  pi.on("tool_call", (event: ToolCallEvent, _ctx: ExtensionContext): ToolCallEventResult | void => {
    const vaultPath = getVaultPath();

    if (isToolCallEventType("bash", event)) {
      let cmd = event.input.command;

      // AC5: ${MEMO_PLUGIN_PWD} → plugin root (exact and bare forms).
      cmd = cmd.replace(/\$\{MEMO_PLUGIN_PWD\}/g, pluginRoot);
      cmd = cmd.replace(/\$MEMO_PLUGIN_PWD\b/g, pluginRoot);

      // AC7: daily overwrite guard (issue #98) — runs on the raw command
      // BEFORE the leading-obsidian rewrite, matching obsidian-cli-rewrite.sh
      // which detects the violation pre-rewrite and skips already-routed
      // commands.
      if (isDailyOverwrite(cmd)) {
        return {
          block: true,
          reason:
            "obsidian create overwrite=true on daily/*.md is forbidden (issue #98). " +
            "Use obsidian create-or-append for appends or obsidian property:set for property updates.",
        };
      }

      // AC6: leading `obsidian` → scripts/obsidian-cli.sh, first token only.
      // Leading whitespace is horizontal-only ([ \t]*) and there is no /m
      // flag, so heredoc / multi-line bodies are never rewritten (parity with
      // the bash hook's line-1-scoped `sed '1 s~^([[:space:]]*)obsidian...'`).
      cmd = cmd.replace(
        /^([ \t]*)obsidian(\s+|$)/,
        `$1"${pluginRoot}/scripts/obsidian-cli.sh"$2`,
      );

      event.input.command = cmd;
      bashCommands.set(event.toolCallId, cmd);
      // Bound the map: aborted runs never reach tool_execution_end, so evict
      // the oldest entry once the cap is exceeded (FIFO via Map order).
      if (bashCommands.size > 500) {
        bashCommands.delete(bashCommands.keys().next().value as string);
      }
      // Only actual mutations set the touched flags - reads (obsidian read,
      // grep, outline, ...) must not record a misleading "vault modified"
      // reflection. Write-verb parity with hooks/log-obsidian-calls.sh: the
      // verb is extracted positionally (first token after the last wrapper),
      // so `obsidian read ... | grep append` does not count as a write.
      const mentionsVault = isObsidianRouted(cmd) || (vaultPath !== null && cmd.includes(vaultPath));
      if (mentionsVault) {
        const verb = extractVerb(cmd);
        if (verb !== null && WRITE_VERB_RE.test(verb)) {
          vaultTouched = true;
          sessionTouched = true;
        }
      }
    }

    // AC12: block direct file I/O on vault paths (bypass allowlist applies).
    if (vaultPath !== null && (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit")) {
      const raw = (event.input as { file_path?: string; path?: string });
      const filePath = String(raw.file_path ?? raw.path ?? "");
      if (filePath) {
        const pair = vaultContainedPair(filePath, vaultPath);
        if (pair) {
          // Bypass-allowlist rel path from the same realpath-normalized values
          // used by containment (parity with block-direct-vault-io.sh, which
          // realpaths both sides first), so symlinked vaults classify
          // .raw/_attachments correctly.
          const rel = pair.abs.slice(pair.vaultAbs.length + 1);
          if (!isVaultBypassed(rel, event.toolName)) {
            const verbMap: Record<string, string> = {
              read: "obsidian read path=<file>",
              write: "obsidian create path=<file> content=\"...\"",
              edit: "obsidian create path=<file> overwrite=true content=\"...\" (full content replacement)",
            };
            return {
              block: true,
              reason: `Direct ${event.toolName} on vault paths is blocked. Use ${verbMap[event.toolName] ?? "obsidian CLI"} instead.`,
            };
          }
        }
      }
    }

    return undefined; // allow
  });

  // ── AC8: inject _shared/INIT.md as a persistent hidden message ─────────────
  // before_agent_start fires once per prompt, not once per session; a
  // session-scoped latch (set via setImmediate so every handler of the first
  // prompt still injects) limits INIT/hot/index injection to the first prompt,
  // matching the Claude Code SessionStart + PostCompact model. session_compact
  // re-injection below is unaffected by the latch.
  let bootstrapServed = false;
  // Project slug cached at before_agent_start so session_compact re-injects the
  // same project's core.md even if process.cwd() changed mid-session (memory:
  // never guess the slug in session_compact).
  let lastProjectSlug: string | undefined;
  const isSessionBootstrap = () => {
    if (bootstrapServed) return false;
    // All handlers of one emit complete within the current task; flip the
    // latch only after the emit finishes so INIT + hot + index all inject on
    // the first prompt.
    setImmediate(() => { bootstrapServed = true; });
    return true;
  };

  pi.on("before_agent_start", (_event, _ctx): BeforeAgentStartEventResult | void => {
    if (!isSessionBootstrap()) return;
    const init = getInitContent();
    if (!init) return;
    return {
      message: {
        customType: "agents-memo-init",
        content: `[agents-memo: _shared/INIT.md]\n${init}`,
        display: false,
      },
    };
  });

  // ── AC9: inject wiki/hot.md when bootstrapReadHot = "always" ────────────────
  pi.on("before_agent_start", (_event, _ctx): BeforeAgentStartEventResult | void => {
    if (!isSessionBootstrap()) return;
    if (readPiSettings().bootstrapReadHot !== "always") return;
    const vaultPath = getVaultPath();
    if (!vaultPath) return;
    const hot = execObsidianRead(vaultPath, "wiki/hot.md");
    if (!hot) return;
    return {
      message: {
        customType: "agents-memo-hot",
        content: `[agents-memo: wiki/hot.md]\n${hot}`,
        display: false,
      },
    };
  });

  // ── AC10: inject wiki/index.md when bootstrapReadIndex = "always" ───────────
  pi.on("before_agent_start", (_event, _ctx): BeforeAgentStartEventResult | void => {
    if (!isSessionBootstrap()) return;
    if (readPiSettings().bootstrapReadIndex !== "always") return;
    const vaultPath = getVaultPath();
    if (!vaultPath) return;
    const index = execObsidianRead(vaultPath, "wiki/index.md");
    if (!index) return;
    return {
      message: {
        customType: "agents-memo-index",
        content: `[agents-memo: wiki/index.md]\n${index}`,
        display: false,
      },
    };
  });

  // ── AC-PM: inject the memory digest (project + global cores) ───────────────
  // Token-lean replacement for phase-1's full project-core injection: top-N
  // learnings from both cores, truncated to digestBudgetChars (design §9.4).
  // The slug is cached so session_compact re-injects the same project's
  // digest even if process.cwd() changed mid-session (memory: never guess
  // the slug in session_compact).
  pi.on("before_agent_start", (_event, ctx): BeforeAgentStartEventResult | void => {
    if (!isSessionBootstrap()) return;
    const config = readPiSettings();
    if (config.projectMemory?.enabled === false) return;
    const vaultPath = getVaultPath();
    if (!vaultPath) return;
    // Slug cached BEFORE the sessionStart flag check: session_compact
    // re-injects whenever reInjectOnCompact alone is on, independent of
    // whether the session-start digest was injected (memory: never guess the
    // slug in session_compact — process.cwd() may have changed by then).
    const slug = getProjectSlug(ctx.cwd);
    lastProjectSlug = slug;
    if (config.memoryInjection?.sessionStart === false) return;
    const digest = buildDigest(vaultPath, slug, config);
    if (!digest) return;
    return {
      message: {
        customType: "agents-memo-memory-digest",
        content: digest,
        display: false,
      },
    };
  });

  // ── AC11: session_compact re-injects hot.md / index.md per bootstrap config ─
  // and the cached project core.md (same pattern as hot/index).
  pi.on("session_compact", (_event: SessionCompactEvent) => {
    const config = readPiSettings();
    const vaultPath = getVaultPath();
    if (!vaultPath) return;

    if (config.bootstrapReadHot === "always") {
      const hot = execObsidianRead(vaultPath, "wiki/hot.md");
      if (hot) {
        pi.sendMessage(
          { customType: "agents-memo-hot", content: `[agents-memo: wiki/hot.md]\n${hot}`, display: false },
          { triggerTurn: false },
        );
      }
    }
    if (config.bootstrapReadIndex === "always") {
      const index = execObsidianRead(vaultPath, "wiki/index.md");
      if (index) {
        pi.sendMessage(
          { customType: "agents-memo-index", content: `[agents-memo: wiki/index.md]\n${index}`, display: false },
          { triggerTurn: false },
        );
      }
    }
    // Digest re-injection uses the slug cached at before_agent_start, never
    // process.cwd() (which may have changed by compaction time), and only
    // when the session actually resolved a vault + slug.
    if (config.memoryInjection?.reInjectOnCompact !== false && config.projectMemory?.enabled !== false && lastProjectSlug) {
      const digest = buildDigest(vaultPath, lastProjectSlug, config);
      if (digest) {
        pi.sendMessage(
          {
            customType: "agents-memo-memory-digest",
            content: digest,
            display: false,
          },
          { triggerTurn: false },
        );
      }
    }
  });

  // ── AC13: tool_execution_end - hot-cache guard (0-byte corruption) ─────────
  pi.on("tool_execution_end", (event: ToolExecutionEndEvent, _ctx: ExtensionContext) => {
    const vaultPath = getVaultPath();
    if (!vaultPath || event.toolName !== "bash") return;

    const cmd = bashCommands.get(event.toolCallId);
    bashCommands.delete(event.toolCallId);
    // Only commands that reference wiki/hot.md can have corrupted it (parity
    // with the bash hook's *wiki/hot.md* match); a bare "hot.md" mention
    // elsewhere (e.g. grep -r hot.md /tmp) is not a corruption candidate.
    if (!cmd || !cmd.includes("wiki/hot.md")) return;

    const hotPath = join(vaultPath, "wiki", "hot.md");
    try {
      if (existsSync(hotPath) && statSync(hotPath).size === 0) {
        // 0-byte corruption detected - restore the last good version from git.
        let restored = false;
        try {
          // spawnSync (no shell interpolation of the config-controlled vault
          // path) resets index AND worktree via checkout HEAD --.
          const result = spawnSync("git", ["-C", vaultPath, "checkout", "HEAD", "--", "wiki/hot.md"], {
            encoding: "utf-8",
            timeout: 5000,
          });
          // HEAD itself may contain the empty blob (corruption already
          // committed) - treat that as not-restorable.
          restored = result.status === 0 && existsSync(hotPath) && statSync(hotPath).size > 0;
        } catch {
          restored = false;
        }
        if (!restored) {
          // No usable prior version - remove the empty file so the next write
          // starts fresh instead of freezing a corrupt state.
          try {
            unlinkSync(hotPath);
          } catch {
            // nothing more to do
          }
        }
        pi.sendMessage(
          {
            customType: "agents-memo-warning",
            content: restored
              ? "⚠️ agents-memo: wiki/hot.md was empty (0 bytes) - restored from git."
              : "⚠️ agents-memo: wiki/hot.md was empty (0 bytes) and no non-empty version exists in git - removed.",
            display: false,
          },
          { triggerTurn: false },
        );
      }
    } catch {
      // file may have been deleted - that's fine
    }
  });

  // ── AC14/AC15: agent_settled - auto-commit + notification ──────────────────
  pi.on("agent_settled", async (_event: AgentSettledEvent, ctx: ExtensionContext) => {
    const config = readPiSettings();
    const vaultPath = getVaultPath();
    // Auto-commit is authoritative from git status, not from the per-run
    // touched flag: agent_end (which owns that flag) fires before
    // agent_settled in the pi runtime, so gating here on vaultTouched would
    // skip auto-commit on every session.
    // Default true (only an explicit false disables) for parity with
    // log-obsidian-calls.sh's unconditional write-verb auto-commit.
    if (!vaultPath || config.autoCommit === false) return;

    try {
      // Status gate scoped to the paths git add stages — Obsidian's own
      // .obsidian/* churn (workspace.json, types.json) would otherwise keep
      // the whole-repo gate permanently open and fire false notifications.
      const status = await pi.exec("git", ["-C", vaultPath, "status", "--porcelain", "--", "wiki/", ".raw/"]);
      if (status.code !== 0 || status.stdout.trim().length === 0) return;
      // pi.exec resolves with {code} on failure (never throws): "nothing to
      // commit" exits 1, so gate the notify on the actual commit result and
      // exit silently otherwise — parity with log-obsidian-calls.sh's
      // `git diff --cached --quiet` gating.
      const add = await pi.exec("git", ["-C", vaultPath, "add", "wiki/", ".raw/"]);
      if (add.code !== 0) return;
      const commit = await pi.exec("git", ["-C", vaultPath, "commit", "-m", "auto: vault changes [agents-memo]"]);
      if (commit.code !== 0) return;
      if (ctx.hasUI) {
        ctx.ui.notify("Wiki updated - changes auto-committed", "info");
      }
    } catch {
      // vault is not a git repo or git failed - skip auto-commit
    }
  });

  // ── AC16: agent_end - reflect the run into project memory (or legacy daily) ─
  pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
    // Consume the per-run flag first so reflection never double-fires and the
    // next run starts clean (agent_end fires before agent_settled in the pi
    // runtime: _emitExtensionEvent → _emitAgentSettled).
    const touched = vaultTouched;
    vaultTouched = false;
    const vaultPath = getVaultPath();
    if (!vaultPath) return;
    const config = readPiSettings();
    if (config.projectMemory?.enabled === false) {
      // Legacy path: static global daily marker (sessions that opted out of
      // per-project pages keep the old behavior unchanged). Stays
      // touched-gated — untouched runs never write the legacy marker.
      if (touched) appendDailyReflection(vaultPath, "[agents-memo] session ended - vault was modified");
      return;
    }
    // Untouched runs reflect only when reflectUntouchedRuns is on (default
    // true): reflection is cheap and sessions that never wrote the vault can
    // still produce learnings worth distilling.
    if (!touched && !config.projectMemory?.reflectUntouchedRuns) return;

    const slug = getProjectSlug(ctx.cwd);
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5);
    const messages = (event.messages ?? []) as ReflectionMessage[];
    if (messages.length === 0) return;
    // In-process complete() wrapped in withTimeout — never blocks the session
    // event loop and strictly bounded (a hung model call resolves null after
    // REFLECTION_MODEL_TIMEOUT_MS instead of freezing the session).
    const reflection = await runReflection(config, ctx, messages.slice(-8));
    if (!reflection) return;
    appendProjectDailyEntry(vaultPath, slug, dateStr, timeStr, reflection);
    updateProjectCore(vaultPath, slug, dateStr, reflection, config.projectMemory?.maxCoreItems ?? PROJECT_MEMORY_DEFAULTS.maxCoreItems);
    // Global bucket: cross-project learnings land in wiki/global-core.md
    // (skipped when the global store is disabled; empty-bucket reflections
    // are a no-op merge over whatever the store already holds).
    if (config.projectMemory?.globalEnabled !== false) {
      updateGlobalCore(
        vaultPath,
        dateStr,
        reflection,
        config.projectMemory?.maxGlobalItems ?? PROJECT_MEMORY_DEFAULTS.maxGlobalItems,
        config.pageCandidacy?.threshold ?? DEFAULT_PAGE_CANDIDACY.threshold,
      );
    }
  });

  // ── AC-PM: promotion sweep command (/wiki promote-global) ─────────────────
  // Deterministic cross-project promotion (§9.6): entries present in
  // >= promotionThreshold project cores move into wiki/global-core.md with a
  // provenance marker. On-demand counterpart of the session_shutdown trigger.
  pi.registerCommand("wiki promote-global", {
    description: "Promote cross-project learnings into wiki/global-core.md (deterministic sweep, no LLM)",
    handler: async (_args, ctx) => {
      const vaultPath = getVaultPath();
      const config = readPiSettings();
      if (!vaultPath) {
        if (ctx.hasUI) ctx.ui.notify("agents-memo: no vault resolved — cannot sweep", "error");
        return;
      }
      if (config.projectMemory?.globalEnabled === false) {
        if (ctx.hasUI) ctx.ui.notify("agents-memo: global memory is disabled (projectMemory.globalEnabled=false)", "error");
        return;
      }
      const result = sweepPromoteGlobal(
        vaultPath,
        config.projectMemory?.promotionThreshold ?? PROJECT_MEMORY_DEFAULTS.promotionThreshold,
        config.projectMemory?.maxGlobalItems ?? PROJECT_MEMORY_DEFAULTS.maxGlobalItems,
      );
      if (ctx.hasUI) {
        ctx.ui.notify(
          result.promoted > 0
            ? `agents-memo: promoted ${result.promoted} cross-project learning(s) into wiki/global-core.md`
            : "agents-memo: nothing to promote (no entry appears in enough project cores)",
          "info",
        );
      }
    },
  });

  // ── AC17: session_shutdown - end-of-session summary reflection ─────────────
  pi.on("session_shutdown", (_event, _ctx) => {
    const vaultPath = getVaultPath(); // for this session's reflection
    bootstrapServed = false; // next session in this process re-injects
    lastProjectSlug = undefined; // stale slug must not leak into the next session
    // Promotion sweep (§9.6): cross-project repeats land in the global core
    // at session end (gated on global memory being enabled). The vaultPath
    // read above guards reload churn — without a vault resolved this session
    // nothing is swept, and an empty store keeps the sweep a no-op.
    const config = readPiSettings();
    if (vaultPath && config.projectMemory?.globalEnabled !== false) {
      sweepPromoteGlobal(
        vaultPath,
        config.projectMemory?.promotionThreshold ?? PROJECT_MEMORY_DEFAULTS.promotionThreshold,
        config.projectMemory?.maxGlobalItems ?? PROJECT_MEMORY_DEFAULTS.maxGlobalItems,
      );
    }
    // Consume the session flags so a shutdown landing mid-run never leaks
    // touches into the next session's first agent_end reflection.
    const touched = sessionTouched;
    vaultTouched = false;
    sessionTouched = false;
    // Invalidate the vault cache LAST: the getVaultPath() read above
    // re-populates it, so resetting first would be undone. A reused process
    // starting in a different cwd then re-resolves on the next session.
    vaultPathCached = null;
    if (!vaultPath || !touched) return;
    appendDailyReflection(vaultPath, "[agents-memo] session shutdown - end-of-session reflection");
  });
}
