import { dirname, join, resolve } from "path";
import {
  CANDIDATE_MARKER_RE,
  escapeShellContent,
  extractCreatedDate,
  FROM_EXTRACT_RE,
  normalizeKey,
  SCORE_MARKER_RE,
} from "./helpers";
import { jaccard } from "./jaccard";
import { getRuntime } from "./runtime";
import {
  DEFAULT_AUTO_COMPACT_THRESHOLD,
  DEFAULT_PAGE_CANDIDACY,
  ensureProjectDir,
  MERGE_FUZZY_THRESHOLD,
  PROJECT_MEMORY_DEFAULTS,
} from "./config";
import { fileURLToPath } from "url";
import { execObsidianReadSafe } from "./obsidian";
import { readdirSync } from "fs";

// ─── core.md management (pure, unit-testable) ────────────────────────────────
export interface CoreEntry {
  text: string;
  score: number;
  // Cross-project provenance (promotion sweep, §9.6): slugs of the project
  // cores an entry was promoted from. Render-side metadata like the score
  // marker — stripped from text on parse, never part of the bullet body.
  from?: string[];
}

// A near-duplicate pair detected by Jaccard bigram similarity on the raw
// entry text (before normalization). The higher-scored entry is kept; the
// lower-scored entry's text is discarded and its score is folded in.
interface MergePair {
  keep: CoreEntry;
  merge: CoreEntry;
  similarity: number;
}

export interface ProjectCore {
  learnings: CoreEntry[];
  watchouts: CoreEntry[];
}

// Distilled session reflection (agent_end). `global` carries cross-project
// learnings promoted to wiki/global-core.md; mistakes/fixes stay project-scoped.
// Lives here (not reflect.ts) so the pure merge engine has no dependency on the
// LLM orchestration module — reflect.ts imports the type, not the reverse.
export interface Reflection {
  mistakes: string[];
  fixes: string[];
  global?: string[];
}

// Merge a reflection into existing entries: fixes → learnings, mistakes →
// watch-outs (rendered with an "Avoid: " prefix). Existing entries get score+1
// on a normalized/fuzzy-text hit; new entries start at 1. Capped at maxItems.
// No age-based decay (non-goal: simple cap + recency).
export function mergeReflection(
  core: ProjectCore,
  reflection: Reflection,
  maxItems: number,
): ProjectCore {
  return {
    learnings: mergeEntries(core.learnings, reflection.fixes, maxItems, MERGE_FUZZY_THRESHOLD),
    watchouts: mergeEntries(core.watchouts, reflection.mistakes, maxItems, MERGE_FUZZY_THRESHOLD),
  };
}

// ─── Plugin root ──────────────────────────────────────────────────────────────
// The extension lives at <pluginRoot>/extensions/agents-memo.ts; the plugin
// root is one level up. jiti loads this module as ESM, so import.meta.url is
// the authoritative location even when the package is installed elsewhere.
export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function projectCoreRel(slug: string): string {
  return `wiki/projects/${slug}/core.md`;
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
      if (section === "watchouts" && body.startsWith("Avoid: "))
        body = body.slice("Avoid: ".length).trim();
      if (!body || body === "(none yet)") continue;
      const entry: CoreEntry = { text: body, score };
      if (from?.length) entry.from = from;
      (section === "learnings" ? learnings : watchouts).push(entry);
    }
  }
  return { learnings, watchouts };
}

// Read wiki/global-core.md (missing = empty core), merge reflection.global
// into learnings with the same dedup/score-increment/cap logic as project
// cores, render, overwrite via the obsidian CLI. Best-effort: never fail the
// agent loop.
export function updateGlobalCore(
  vaultPath: string,
  dateStr: string,
  reflection: Reflection,
  maxGlobalItems: number = PROJECT_MEMORY_DEFAULTS.maxGlobalItems,
  candidacyThreshold: number = DEFAULT_PAGE_CANDIDACY.threshold,
): void {
  try {
    const relPath = "wiki/global-core.md";
    // Read-failure guard: a transient CLI failure must not be conflated with
    // an empty store, or the accumulated corpus gets clobbered by a render of
    // just this reflection. Missing file (ok, empty content) proceeds.
    const read = execObsidianReadSafe(vaultPath, relPath);
    if (!read.ok) return;
    const core = read.content ? parseCoreFile(read.content) : { learnings: [], watchouts: [] };
    const merged = mergeEntries(
      core.learnings,
      reflection.global ?? [],
      maxGlobalItems,
      MERGE_FUZZY_THRESHOLD,
    );
    const rendered = renderGlobalCore(
      extractCreatedDate(read.content) ?? dateStr,
      dateStr,
      merged,
      candidacyThreshold,
    );
    const obsCli = join(pluginRoot, "scripts", "obsidian-cli.sh");
    getRuntime().exec(
      `bash "${obsCli}" create path=${relPath} overwrite=true content="${escapeShellContent(rendered)}"`,
      { cwd: vaultPath, encoding: "utf-8", timeout: 10000 },
    );
  } catch {
    // best-effort - never fail the agent loop
  }
}

// Merge incoming strings (or provenance-carrying promoted items) into an
// entry list: dedup by normalized key, score+1 on a hit (provenance unions),
// new entries start at 1. Sorted by score desc (stable for ties), capped at
// maxItems. Shared by the project and global cores and the promotion sweep so
// the dedup/score/cap semantics can never diverge between them.
export function mergeEntries(
  entries: CoreEntry[],
  incoming: Array<string | { text: string; from?: string[] }>,
  maxItems: number,
  fuzzyThreshold?: number,
): CoreEntry[] {
  const byKey = new Map(entries.map((e) => [normalizeKey(e.text), e]));
  const unmatched: Array<{ text: string; from?: string[] }> = [];

  // Phase 1: exact dedup via normalizeKey (Porter stemming + stopwords).
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
      unmatched.push({ text, from: item.from });
    }
  }

  // Phase 2: fuzzy dedup via Jaccard bigram similarity. Only runs when a
  // threshold is set and there are unmatched items. At 0.65 this catches
  // LLM rephrasings of the same concept while staying well above false-
  // positive territory (different concepts rarely exceed ~0.3).
  if (fuzzyThreshold !== undefined && unmatched.length > 0) {
    const existingEntries = [...byKey.values()];
    for (const item of unmatched) {
      let bestMatch: CoreEntry | undefined;
      let bestSim = 0;
      for (const entry of existingEntries) {
        const sim = jaccard(item.text, entry.text);
        if (sim >= fuzzyThreshold && sim > bestSim) {
          bestSim = sim;
          bestMatch = entry;
        }
      }
      if (bestMatch) {
        bestMatch.score += 1;
        if (item.from?.length) {
          bestMatch.from = [...new Set([...(bestMatch.from ?? []), ...item.from])].sort();
        }
      } else {
        const entry: CoreEntry = { text: item.text, score: 1 };
        if (item.from?.length) entry.from = [...item.from].sort();
        byKey.set(normalizeKey(item.text), entry);
      }
    }
  } else {
    for (const item of unmatched) {
      const entry: CoreEntry = { text: item.text, score: 1 };
      if (item.from?.length) entry.from = [...item.from].sort();
      byKey.set(normalizeKey(item.text), entry);
    }
  }

  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, maxItems);
}

// Find near-duplicate pairs among entries whose raw text has Jaccard bigram
// similarity >= threshold. Normalized-key dedup catches exact repeats, but
// rephrased bullets ("Use DI" vs "Prefer dependency injection") slip through
// because their normalized forms differ. Bigram similarity catches these.
// Pairs are sorted by similarity desc (most-similar first); within a tie the
// higher-scored entry is "keep" so the highest-impact bullet survives.
export function findMergePairs(entries: CoreEntry[], threshold: number): MergePair[] {
  const pairs: MergePair[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const sim = jaccard(entries[i].text, entries[j].text);
      if (sim >= threshold) {
        const a = entries[i];
        const b = entries[j];
        pairs.push({
          keep: a.score >= b.score ? a : b,
          merge: a.score >= b.score ? b : a,
          similarity: sim,
        });
      }
    }
  }
  return pairs.sort((a, b) => b.similarity - a.similarity);
}

export function updateProjectCore(
  vaultPath: string,
  slug: string,
  dateStr: string,
  reflection: Reflection,
  maxCoreItems: number = PROJECT_MEMORY_DEFAULTS.maxCoreItems,
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
    getRuntime().exec(
      `bash "${obsCli}" create path=${relPath} overwrite=true content="${escapeShellContent(rendered)}"`,
      { cwd: vaultPath, encoding: "utf-8", timeout: 10000 },
    );
  } catch {
    // best-effort - never fail the agent loop
  }
}

// Compact a project core by merging near-duplicate entries whose raw text
// has Jaccard bigram similarity >= threshold. Read-failure guard (parity with
// updateProjectCore): a transient CLI failure skips and a missing file is a
// no-op. Returns the number of pairs merged, or null on failure / no-op.
export function compactCoreFile(
  vaultPath: string,
  slug: string,
  threshold: number = DEFAULT_AUTO_COMPACT_THRESHOLD,
): number | null {
  try {
    const relPath = projectCoreRel(slug);
    const read = execObsidianReadSafe(vaultPath, relPath);
    if (!read.ok) return null;
    const core = read.content ? parseCoreFile(read.content) : { learnings: [], watchouts: [] };
    const pairs = findMergePairs(core.learnings, threshold);
    if (pairs.length === 0) return 0;
    const compacted = applyMerges(core.learnings, pairs);
    // Re-render with the today's date; the original created date is not
    // preserved on compact (unlike global core updates) — compact is a
    // structural reshaping, not a merge of new data.
    const dateStr = new Date().toISOString().slice(0, 10);
    const rendered = renderCoreFile(slug, dateStr, {
      learnings: compacted,
      watchouts: core.watchouts,
    });
    const obsCli = join(pluginRoot, "scripts", "obsidian-cli.sh");
    getRuntime().exec(
      `bash "${obsCli}" create path=${relPath} overwrite=true content="${escapeShellContent(rendered)}"`,
      { cwd: vaultPath, encoding: "utf-8", timeout: 10000 },
    );
    return pairs.length;
  } catch {
    return null;
  }
}

// Apply merge pairs to an entry list: remove every item designated as "merge",
// keep every "keep" item (mutated in-place so scores accumulate across pairs).
// An entry can appear in multiple pairs (e.g. A pairs with B and C); its score
// is boosted once per pair where it is the keeper. Returns the filtered list.
export function applyMerges(entries: CoreEntry[], pairs: MergePair[]): CoreEntry[] {
  const toRemove = new Set(pairs.map((p) => p.merge));
  for (const pair of pairs) {
    pair.keep.score += pair.merge.score;
  }
  return entries.filter((e) => !toRemove.has(e));
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

export function renderGlobalCore(
  createdDate: string,
  updatedDate: string,
  learnings: CoreEntry[],
  candidacyThreshold: number,
): string {
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

export function renderCoreFile(slug: string, dateStr: string, core: ProjectCore): string {
  const renderSection = (title: string, entries: CoreEntry[], isWatchout: boolean): string => {
    if (entries.length === 0) return `## ${title}\n- (none yet)\n`;
    const bullets = entries.map(
      (e) => `- ${isWatchout ? "Avoid: " : ""}${e.text}<!--score:${e.score}-->`,
    );
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
  promotionThreshold: number = PROJECT_MEMORY_DEFAULTS.promotionThreshold,
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
    const candidates = collectCrossProjectEntries(
      projects,
      promotionThreshold,
      MERGE_FUZZY_THRESHOLD,
    );
    if (candidates.length === 0) return { promoted: 0 };

    const relPath = "wiki/global-core.md";
    const existing = execObsidianReadSafe(vaultPath, relPath);
    if (!existing.ok) return { promoted: 0 };
    const core = existing.content
      ? parseCoreFile(existing.content)
      : { learnings: [], watchouts: [] };
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
    const rendered = renderGlobalCore(
      extractCreatedDate(existing.content) ?? new Date().toISOString().slice(0, 10),
      new Date().toISOString().slice(0, 10),
      merged,
      DEFAULT_PAGE_CANDIDACY.threshold,
    );
    const obsCli = join(pluginRoot, "scripts", "obsidian-cli.sh");
    getRuntime().exec(
      `bash "${obsCli}" create path=${relPath} overwrite=true content="${escapeShellContent(rendered)}"`,
      { cwd: vaultPath, encoding: "utf-8", timeout: 10000 },
    );
    return { promoted: incoming.length };
  } catch {
    return { promoted: 0 };
  }
}

interface PromotedEntry {
  text: string;
  slugs: string[];
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

export function findCrossProjectEntries(
  projects: Record<string, string[]>,
  threshold: number,
  fuzzyThreshold?: number,
): string[] {
  return collectCrossProjectEntries(projects, threshold, fuzzyThreshold).map((e) => e.text);
}

function collectCrossProjectEntries(
  projects: Record<string, string[]>,
  threshold: number,
  fuzzyThreshold?: number,
): PromotedEntry[] {
  const byKey = new Map<string, { text: string; slugs: Set<string> }>();
  for (const [slug, entries] of Object.entries(projects)) {
    for (const raw of entries) {
      const text = raw.trim();
      if (!text) continue;
      const key = normalizeKey(text);
      const rec = byKey.get(key);
      if (rec) {
        rec.slugs.add(slug);
        continue;
      }

      // Fuzzy match across projects when threshold is set.
      if (fuzzyThreshold !== undefined) {
        let bestKey: string | undefined;
        let bestSim = 0;
        for (const [existingKey, existing] of byKey) {
          const sim = jaccard(text, existing.text);
          if (sim >= fuzzyThreshold && sim > bestSim) {
            bestSim = sim;
            bestKey = existingKey;
          }
        }
        if (bestKey) {
          byKey.get(bestKey)!.slugs.add(slug);
          continue;
        }
      }

      byKey.set(key, { text, slugs: new Set([slug]) });
    }
  }
  return (
    [...byKey.values()]
      .filter((rec) => rec.slugs.size >= threshold)
      // Deterministic order: most-spread first, then text.
      .sort((a, b) => b.slugs.size - a.slugs.size || a.text.localeCompare(b.text))
      .map((rec) => ({ text: rec.text, slugs: [...rec.slugs].sort() }))
  );
}
