/**
 * AGENTS.md pointer management for /memo:init.
 *
 * The plugin-managed zone is delimited by HTML-comment markers so re-running
 * init replaces only that block and never clobbers hand-written content. Kept
 * separate from the extension entry point so the marker contract is a pure,
 * unit-testable function.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pluginRoot } from "./core-management";

const WIKI_POINTER_BEGIN = "<!-- agents-memo:begin -->";
const WIKI_POINTER_END = "<!-- agents-memo:end -->";

/**
 * Upsert a marker-wrapped block into markdown content.
 *
 * The managed block lives at the END of the file (append contract). Only a
 * complete `begin … end` pair at the end of the file is replaced; any other
 * marker occurrences (e.g. code-fenced doc examples explaining the format) are
 * never touched. Returns the original content when nothing changes.
 */
export function upsertMarkedBlock(content: string, block: string): string {
  const b = content.lastIndexOf(WIKI_POINTER_BEGIN);
  const e = content.lastIndexOf(WIKI_POINTER_END);
  if (b !== -1 && e > b) {
    const after = content.slice(e + WIKI_POINTER_END.length);
    if (after.trim() === "") {
      return `${content.slice(0, b)}${block}${after}`;
    }
  }
  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  return `${content}${separator}${block}`;
}

/** Write (or marker-refresh) the vault's own AGENTS.md from the _seed template. */
export function writeVaultAgentsMd(vaultPath: string): void {
  const templatePath = join(pluginRoot, "_seed", "AGENTS.md");
  if (!existsSync(templatePath)) return;
  const content = readFileSync(templatePath, "utf-8")
    .replaceAll("{{PLUGIN_ROOT}}", pluginRoot)
    .replaceAll("{{VAULT_PATH}}", vaultPath);
  const target = join(vaultPath, "AGENTS.md");
  if (existsSync(target)) {
    // agents-md marker contract: refresh only the marked zone; leave
    // hand-written (unmarked) vault AGENTS.md files alone.
    const existing = readFileSync(target, "utf-8");
    const updated = upsertMarkedBlock(existing, content);
    if (updated !== existing) writeFileSync(target, updated);
    return;
  }
  writeFileSync(target, content);
}

/** Add (or refresh) the Wiki Knowledge Base pointer in a consumer project. */
export function appendWikiPointer(cwd: string, vaultPath: string): void {
  const target = join(cwd, "AGENTS.md");
  const block =
    `${WIKI_POINTER_BEGIN}\n` +
    `## Wiki Knowledge Base\n` +
    `Path: ${vaultPath}\n` +
    `When needed: (1) read wiki/hot.md first, (2) read wiki/index.md, (3) drill into domain pages.\n` +
    `Use it for architectural quirks and complex concepts; skip it for straightforward\n` +
    `questions answerable from common knowledge or the code.\n` +
    `${WIKI_POINTER_END}\n`;
  const existing = existsSync(target) ? readFileSync(target, "utf-8") : "";
  const updated = upsertMarkedBlock(existing, block);
  if (updated !== existing || !existsSync(target)) {
    writeFileSync(target, updated);
  }
}
