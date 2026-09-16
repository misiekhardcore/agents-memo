import { describe, expect, it } from "vitest";
import { readPiSettings } from "../../extensions/config";
import { projectCoreRel } from "../../extensions/core-management";
import { buildDigest } from "../../extensions/digest";
import { useIntegrationHarness } from "../helpers/integration";

const SLUG = "proj";

function seedProject(): string {
  return [
    "---",
    "type: project-core",
    `project: ${SLUG}`,
    "created: 2026-08-07",
    "updated: 2026-08-07",
    "---",
    "",
    `# Project Learnings — ${SLUG}`,
    "",
    "## High-value learnings",
    "- Keep edits small<!--score:4-->",
    "- Verify before claiming<!--score:2-->",
    "- Trace config keys<!--score:1-->",
    "",
    "## Watch-outs",
    "- Avoid: guess without verifying<!--score:1-->",
    "",
  ].join("\n");
}

function seedGlobal(): string {
  return [
    "---",
    "type: global-core",
    "created: 2026-08-07",
    "updated: 2026-08-07",
    "---",
    "",
    "# Global Learnings",
    "",
    "## High-value learnings",
    "- Prefer small diffs<!--score:5-->",
    "- Reusable pattern<!--score:3-->",
    "- Low score item<!--score:1-->",
    "",
  ].join("\n");
}

describe("buildDigest", () => {
  const harness = useIntegrationHarness();

  it("builds a budgeted digest from both cores", () => {
    const projectFiles = harness.state.projectFiles;
    const failReads = harness.state.failReads;
    const vault = harness.scratch.vault;
    const cfg = readPiSettings(vault); // defaults: tops 5, budget 800, threshold 3
    projectFiles.set(projectCoreRel(SLUG), seedProject());
    projectFiles.set("wiki/global-core.md", seedGlobal());

    const digest = buildDigest(vault, SLUG, cfg);
    expect(digest).toBeTruthy();
    expect(digest?.startsWith(`[agents-memo memory]\n## Project learnings (${SLUG})`)).toBe(true);
    expect(digest).toContain("## Global learnings");
    expect(digest).toContain("- Keep edits small");
    expect(digest).toContain("- Prefer small diffs");
    expect(digest).not.toContain("Avoid: guess");
    expect(digest).toContain("Full memory on demand: /memo-query or obsidian search.");

    const smallCfg = {
      ...cfg,
      memoryInjection: { ...cfg.memoryInjection!, projectCoreTop: 2, globalCoreTop: 1 },
    };
    const small = buildDigest(vault, SLUG, smallCfg);
    expect(small).toContain("- Keep edits small");
    expect(small).toContain("- Verify before claiming");
    expect(small).not.toContain("- Trace config keys");
    expect(small).toContain("- Prefer small diffs");
    expect(small).not.toContain("- Reusable pattern");
    expect(small).toContain("Page candidates: 2");

    // Budget truncation at bullet boundaries.
    const pointer = digest!.slice(digest!.indexOf("\n\nPage candidates:"));
    const header = `[agents-memo memory]\n## Project learnings (${SLUG})\n## Global learnings`;
    const budgetOne = header.length + "- Keep edits small".length + pointer.length + 1;
    const one = buildDigest(vault, SLUG, {
      ...cfg,
      memoryInjection: { ...cfg.memoryInjection!, digestBudgetChars: budgetOne },
    });
    expect(one).toBeTruthy();
    expect(one!.length).toBeLessThanOrEqual(budgetOne);
    expect(one).toContain("- Keep edits small");
    expect(one).not.toContain("- Verify before claiming");
    expect(one).toContain("Full memory on demand");

    const noBullets = buildDigest(vault, SLUG, {
      ...cfg,
      memoryInjection: { ...cfg.memoryInjection!, digestBudgetChars: 1 },
    });
    expect(noBullets).toBeTruthy();
    expect(noBullets).not.toContain("- Keep edits small");
    expect(noBullets).toContain("[agents-memo memory]");
    expect(noBullets).toContain("Full memory on demand: /memo-query or obsidian search.");

    // Empty/missing cores → null.
    projectFiles.delete("wiki/global-core.md");
    projectFiles.delete(projectCoreRel(SLUG));
    expect(buildDigest(vault, SLUG, cfg)).toBeNull();
    projectFiles.set(projectCoreRel(SLUG), "# Project Learnings\n\n## High-value learnings\n- (none yet)\n");
    projectFiles.set("wiki/global-core.md", "# Global Learnings\n\n## High-value learnings\n- (none yet)\n");
    expect(buildDigest(vault, SLUG, cfg)).toBeNull();

    // Read failures tolerated per-side.
    projectFiles.set(projectCoreRel(SLUG), seedProject());
    projectFiles.set("wiki/global-core.md", seedGlobal());
    failReads.set("wiki/global-core.md", "Error: CLI exploded");
    const oneSided = buildDigest(vault, SLUG, cfg);
    expect(oneSided).toBeTruthy();
    expect(oneSided).toContain("- Keep edits small");
    expect(oneSided).not.toContain("- Prefer small diffs");
    failReads.set(projectCoreRel(SLUG), "Error: CLI exploded");
    expect(buildDigest(vault, SLUG, cfg)).toBeNull();
  });
});
