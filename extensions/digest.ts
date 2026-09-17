// ─── Digest builder ──────────────────────────────────────────────────────────
// Token-lean session-start context (design §9.4): top project + global
// learnings by score, truncated at bullet boundaries to digestBudgetChars.
// Read-only — never writes the vault. Returns null when both cores are
// empty/missing (nothing to inject) so callers skip injection entirely.
//
// Read failures are tolerated per-side (a transient CLI failure skips that
// side, not the whole digest) — the digest is read-only so there is no
// clobber risk, unlike updateGlobalCore's write pipeline.

import { AgentsMemoConfig, DEFAULT_MEMORY_INJECTION, DEFAULT_PAGE_CANDIDACY } from "./config";
import { CoreEntry, parseCoreFile, projectCoreRel } from "./core-management";
import { execObsidianReadSafe } from "./obsidian";

// Exported for the smoke test (pi only invokes the default export).
export function buildDigest(
  vaultPath: string,
  slug: string,
  config: AgentsMemoConfig,
): string | null {
  const injection = config.memoryInjection ?? DEFAULT_MEMORY_INJECTION;
  const threshold = config.pageCandidacy?.threshold ?? DEFAULT_PAGE_CANDIDACY.threshold;

  const projRead = execObsidianReadSafe(vaultPath, projectCoreRel(slug));
  const globalRead = execObsidianReadSafe(vaultPath, "wiki/global-core.md");
  const projCore = projRead.ok ? parseCoreFile(projRead.content) : { learnings: [], watchouts: [] };
  const globalCore = globalRead.ok
    ? parseCoreFile(globalRead.content)
    : { learnings: [], watchouts: [] };
  // Stable score-desc sort before slicing: cores are stored score-sorted, but
  // hand-edited files must still yield the top entries deterministically.
  const byScore = (entries: CoreEntry[]): CoreEntry[] =>
    [...entries].sort((a, b) => b.score - a.score);
  const projTop = byScore(projCore.learnings).slice(0, injection.projectCoreTop);
  const globalTop = byScore(globalCore.learnings).slice(0, injection.globalCoreTop);
  if (projTop.length === 0 && globalTop.length === 0) return null;

  // Page-candidacy nudge counts every global learning at/above the threshold
  // (the store's stable-truth pool, not just the bullets shown in the digest).
  const candidates = globalCore.learnings.filter((e) => e.score >= threshold).length;
  const header = `[agents-memo memory]\n## Project learnings (${slug})\n## Global learnings`;
  const pointer = `\n\nPage candidates: ${candidates} (score >= ${threshold}) — promote via /memo-save or ask the agent\nFull memory on demand: /memo-query or obsidian search.`;
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
