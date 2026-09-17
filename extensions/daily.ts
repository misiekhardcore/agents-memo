import { escapeShellContent } from "./helpers";
import { join } from "path";
import { pluginRoot } from "./core-management";
import { ensureProjectDir } from "./config";
import { Reflection } from "./core-management";
import { getRuntime } from "./runtime";

export function appendProjectDailyEntry(
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
      "---\\ntype: project-daily\\nproject: " +
      slug +
      "\\ndate: " +
      dateStr +
      "\\ncreated: " +
      dateStr +
      "\\nupdated: " +
      dateStr +
      "\\n---\\n\\n## Reflections\\n";
    const mistakes = reflection.mistakes.map((m) => `- ${m}`).join("\\n") || "- (none)";
    const fixes = reflection.fixes.map((f) => `- ${f}`).join("\\n") || "- (none)";
    const content =
      `## ${timeStr} Reflection\\n` + `### Mistakes\\n${mistakes}\\n` + `### Fixes\\n${fixes}\\n`;
    getRuntime().exec(
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

function projectDailyRel(slug: string, dateStr: string): string {
  return `wiki/projects/${slug}/daily/${dateStr}.md`;
}

export function appendDailyReflection(vaultPath: string, label: string): void {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5);
  try {
    const obsCli = join(pluginRoot, "scripts", "obsidian-cli.sh");
    const template =
      "---\\ntype: daily\\ndate: " +
      dateStr +
      "\\ncreated: " +
      dateStr +
      "\\nupdated: " +
      dateStr +
      "\\n---\\n\\n## Captures\\n";
    getRuntime().exec(
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

// ─── Daily overwrite guard (issue #98) ────────────────────────────────────────
// Parity with hooks/obsidian-cli-rewrite.sh: checked on the command BEFORE the
// leading-obsidian rewrite, already-routed commands (mentioning obsidian-cli)
// pass through (the bash hook early-exits on them), `obsidian` must appear
// before `create` (bash glob `*obsidian*create*`), and the daily path class
// mirrors the bash grep `path=("?)daily/[^[:space:]"]*\.md`.
export function isDailyOverwrite(command: string): boolean {
  if (command.includes("obsidian-cli")) return false;
  const obsIdx = command.indexOf("obsidian");
  const createIdx = command.indexOf("create");
  if (obsIdx === -1 || createIdx === -1 || createIdx < obsIdx) return false;
  const hasDailyPath = /path=("?)daily\/[^\s"]*\.md/.test(command);
  const hasOverwrite = /overwrite=true|overwrite=1|overwrite(\s|$)/.test(command);
  return hasDailyPath && hasOverwrite;
}
