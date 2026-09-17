import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyMerges,
  compactCoreFile,
  findCrossProjectEntries,
  findMergePairs,
  mergeReflection,
  parseCoreFile,
  renderCoreFile,
  renderGlobalCore,
  sweepPromoteGlobal,
  updateGlobalCore,
  updateProjectCore,
} from "../../extensions/core-management";
import { execObsidianReadSafe } from "../../extensions/obsidian";
import { useIntegrationHarness } from "../helpers/integration";

const SLUG = "proj";

function projectCore(overrides: Partial<Record<"learnings" | "watchouts", string>> = {}): string {
  return [
    "---",
    "type: project-core",
    `project: ${SLUG}`,
    "created: 2026-08-06",
    "updated: 2026-08-06",
    "---",
    "",
    `# Project Learnings — ${SLUG}`,
    "",
    "## High-value learnings",
    overrides.learnings ?? "- Keep edits small<!--score:1-->",
    "",
    "## Watch-outs",
    overrides.watchouts ?? "- Avoid: guess without verifying<!--score:1-->",
    "",
  ].join("\n");
}

const CORE_SEED = projectCore();

describe("core.md pure functions", () => {
  it("parses bullets, strips markers and 'Avoid:' prefixes", () => {
    const parsed = parseCoreFile(CORE_SEED);
    expect(parsed.learnings).toHaveLength(1);
    expect(parsed.learnings[0]).toMatchObject({ text: "Keep edits small", score: 1 });
    expect(parsed.watchouts).toHaveLength(1);
    expect(parsed.watchouts[0]).toMatchObject({ text: "guess without verifying", score: 1 });
    expect(parsed.learnings[0].text).not.toContain("<!--");
  });

  it("merges a reflection: score+1 on hit, new entries at 1, capped", () => {
    const parsed = parseCoreFile(CORE_SEED);
    const reflection = {
      mistakes: ["guess without verifying", "new mistake"],
      fixes: ["Keep edits small", "write tests first"],
    };
    const merged = mergeReflection(parsed, reflection, 20);
    expect(merged.learnings).toHaveLength(2);
    expect(merged.learnings.find((e) => e.text === "Keep edits small")?.score).toBe(2);
    expect(merged.learnings.find((e) => e.text === "write tests first")?.score).toBe(1);
    expect(merged.watchouts.find((e) => e.text === "guess without verifying")?.score).toBe(2);
    expect(merged.watchouts.some((e) => e.text === "new mistake")).toBe(true);

    const capped = mergeReflection({ learnings: [], watchouts: [] }, { mistakes: [], fixes: ["a", "b", "c", "d"] }, 3);
    expect(capped.learnings).toHaveLength(3);

    const dup = mergeReflection(
      { learnings: [{ text: "Keep Edits Small", score: 1 }], watchouts: [] },
      { mistakes: [], fixes: ["Keep edits   small"] },
      5,
    );
    expect(dup.learnings).toHaveLength(1);
    expect(dup.learnings[0].score).toBe(2);
  });

  it("renders and round-trips a project core", () => {
    const merged = mergeReflection(parseCoreFile(CORE_SEED), {
      mistakes: ["guess without verifying", "new mistake"],
      fixes: ["Keep edits small", "write tests first"],
    }, 20);
    const rendered = renderCoreFile(SLUG, "2026-08-06", merged);
    expect(rendered).toContain("type: project-core");
    expect(rendered).toContain("## High-value learnings");
    expect(rendered).toContain("<!--score:2-->");
    expect(rendered).toContain("- Avoid: guess without verifying");
    const reparsed = parseCoreFile(rendered);
    expect(reparsed.learnings).toHaveLength(merged.learnings.length);
  });
});

describe("global-core render/merge/update", () => {
  const harness = useIntegrationHarness();

  it("renders frontmatter, candidates and round-trips", () => {
    const learnings = [
      { text: "Prefer small, reviewable diffs", score: 3 },
      { text: "Trace config keys to call sites before claiming dead", score: 1 },
    ];
    const rendered = renderGlobalCore("2026-08-01", "2026-08-07", learnings, 3);
    expect(rendered.startsWith("---\ntype: global-core")).toBe(true);
    expect(rendered).toContain("created: 2026-08-01");
    expect(rendered).toContain("updated: 2026-08-07");
    expect(rendered).toContain("# Global Learnings");
    expect(rendered).toContain("## High-value learnings");
    expect(rendered).not.toContain("## Watch-outs");
    expect(rendered).toContain("Prefer small, reviewable diffs<!--score:3--><!--candidate-->");
    const traceLine = rendered.split("\n").find((l) => l.includes("Trace config"));
    expect(traceLine).toBeTruthy();
    expect(traceLine).not.toContain("<!--candidate-->");

    const reparsed = parseCoreFile(rendered);
    expect(reparsed.learnings).toHaveLength(2);
    expect(reparsed.learnings[0]).toMatchObject({ text: "Prefer small, reviewable diffs", score: 3 });
    expect(reparsed.watchouts).toHaveLength(0);
    expect(reparsed.learnings.some((e) => e.text.includes("<!--"))).toBe(false);
  });

  it("dedups wikilink bullets exactly and increments scores", () => {
    const projectFiles = harness.state.projectFiles;
    projectFiles.set(
      "wiki/global-core.md",
      [
        "---",
        "type: global-core",
        "created: 2026-08-01",
        "updated: 2026-08-01",
        "---",
        "",
        "# Global Learnings",
        "",
        "## High-value learnings",
        "- Prefer small, reviewable diffs [[review-process]]<!--score:2-->",
        "",
      ].join("\n"),
    );
    updateGlobalCore(
      harness.scratch.vault,
      "2026-08-07",
      { mistakes: [], fixes: [], global: ["Prefer   small, reviewable diffs"] },
      5,
      3,
    );
    const merged = projectFiles.get("wiki/global-core.md") ?? "";
    expect(merged).toContain(
      "- Prefer small, reviewable diffs [[review-process]]<!--score:3--><!--candidate-->",
    );
    expect(merged).toContain("[[review-process]]");
    const parsed = parseCoreFile(merged);
    expect(parsed.learnings).toHaveLength(1);
    expect(parsed.learnings[0].score).toBe(3);
  });

  it("caps global entries and starts fresh when the file is missing", () => {
    const projectFiles = harness.state.projectFiles;
    projectFiles.delete("wiki/global-core.md");
    updateGlobalCore(harness.scratch.vault, "2026-08-07", { mistakes: [], fixes: [], global: ["a", "b", "c", "d"] }, 2, 3);
    const capped = parseCoreFile(projectFiles.get("wiki/global-core.md") ?? "");
    expect(capped.learnings).toHaveLength(2);

    projectFiles.delete("wiki/global-core.md");
    updateGlobalCore(harness.scratch.vault, "2026-08-07", { mistakes: ["m"], fixes: ["f"], global: ["Reusable pattern"] }, 20, 3);
    const fresh = projectFiles.get("wiki/global-core.md") ?? "";
    expect(fresh).toContain("- Reusable pattern<!--score:1-->");
    expect(fresh).not.toContain("- m");
    expect(fresh).not.toContain("- f");
    expect(fresh).not.toContain("<!--candidate-->");
  });

  it("treats an empty global bucket as a no-op merge", () => {
    const projectFiles = harness.state.projectFiles;
    projectFiles.delete("wiki/global-core.md");
    updateGlobalCore(harness.scratch.vault, "2026-08-07", { mistakes: [], fixes: [], global: ["Reusable pattern"] }, 20, 3);
    updateGlobalCore(harness.scratch.vault, "2026-08-07", { mistakes: ["m"], fixes: ["f"], global: [] }, 20, 3);
    const noop = projectFiles.get("wiki/global-core.md") ?? "";
    expect(noop).toContain("- Reusable pattern<!--score:1-->");
    expect(noop).not.toContain("- m");
  });

  it("preserves the original created date across merges", () => {
    const projectFiles = harness.state.projectFiles;
    projectFiles.set(
      "wiki/global-core.md",
      [
        "---",
        "type: global-core",
        "created: 2026-08-01",
        "updated: 2026-08-01",
        "---",
        "",
        "# Global Learnings",
        "",
        "## High-value learnings",
        "- Old entry<!--score:2-->",
        "",
      ].join("\n"),
    );
    updateGlobalCore(harness.scratch.vault, "2026-08-07", { mistakes: [], fixes: [], global: ["New entry"] }, 20, 3);
    const dated = projectFiles.get("wiki/global-core.md") ?? "";
    expect(dated).toContain("created: 2026-08-01");
    expect(dated).toContain("updated: 2026-08-07");
    expect(dated).toContain("- New entry<!--score:1-->");

    projectFiles.delete("wiki/global-core.md");
    updateGlobalCore(harness.scratch.vault, "2026-08-07", { mistakes: [], fixes: [], global: ["Brand new"] }, 20, 3);
    const fresh = projectFiles.get("wiki/global-core.md") ?? "";
    expect(fresh).toContain("created: 2026-08-07");
    expect(fresh).toContain("updated: 2026-08-07");
  });

  it("escapes shell metacharacters in reflection-generated bullets", () => {
    const projectFiles = harness.state.projectFiles;
    projectFiles.delete("wiki/global-core.md");
    const before = harness.state.execCalls.length;
    updateGlobalCore(
      harness.scratch.vault,
      "2026-08-07",
      { mistakes: [], fixes: [], global: ["use $(echo PWNED) and `whoami`"] },
      5,
      3,
    );
    const cmd =
      harness.state.execCalls
        .slice(before)
        .find((c) => c.includes("wiki/global-core.md") && c.includes("overwrite=true")) ?? "";
    expect(cmd).toContain("\\$(echo PWNED)");
    expect(cmd).toContain("\\`whoami\\`");
    expect(cmd).not.toMatch(/(^|[^\\])\$\(/);
    expect(cmd).not.toMatch(/(^|[^\\])`/);
  });

  it("guards against clobbering on read failure", () => {
    const projectFiles = harness.state.projectFiles;
    const failReads = harness.state.failReads;
    projectFiles.delete("wiki/global-core.md");

    const missing = execObsidianReadSafe(harness.scratch.vault, "wiki/global-core.md");
    expect(missing).toEqual({ ok: true, content: "" });

    failReads.set("wiki/global-core.md", 'Error: File "wiki/global-core.md" not found.');
    expect(execObsidianReadSafe(harness.scratch.vault, "wiki/global-core.md")).toEqual({
      ok: true,
      content: "",
    });
    failReads.delete("wiki/global-core.md");

    failReads.set("wiki/global-core.md", "Error: something broke");
    updateGlobalCore(harness.scratch.vault, "2026-08-07", { mistakes: [], fixes: [], global: ["should not land"] }, 20, 3);
    expect(projectFiles.get("wiki/global-core.md")).toBeUndefined();
    failReads.delete("wiki/global-core.md");

    updateGlobalCore(harness.scratch.vault, "2026-08-07", { mistakes: [], fixes: [], global: ["Fresh start"] }, 20, 3);
    expect(projectFiles.get("wiki/global-core.md") ?? "").toContain("- Fresh start<!--score:1-->");

    // updateProjectCore gets the same guard.
    const projRel = `wiki/projects/${SLUG}/core.md`;
    const projSeed = projectCore({ learnings: "- Keep edits small<!--score:2-->" });
    projectFiles.set(projRel, projSeed);
    failReads.set(projRel, "Error: something broke");
    updateProjectCore(harness.scratch.vault, SLUG, "2026-08-07", { mistakes: [], fixes: ["should not land"], global: [] }, 20);
    expect(projectFiles.get(projRel)).toBe(projSeed);
    failReads.delete(projRel);
    projectFiles.delete(projRel);
    updateProjectCore(harness.scratch.vault, SLUG, "2026-08-07", { mistakes: [], fixes: ["Fresh fix"], global: [] }, 20);
    expect(projectFiles.get(projRel) ?? "").toContain("- Fresh fix<!--score:1-->");
  });
});

describe("core compact (Jaccard merge)", () => {
  const harness = useIntegrationHarness();

  it("finds near-duplicate pairs and applies merges", () => {
    const entries = [
      { text: "Use dependency injection for all services", score: 3 },
      { text: "Use dependency injection in every module", score: 2 },
      { text: "Write tests first", score: 1 },
    ];
    const low = findMergePairs(entries, 0.3);
    expect(low).toHaveLength(1);
    expect(low[0].similarity).toBeGreaterThanOrEqual(0.3);
    expect(findMergePairs(entries, 0.95)).toHaveLength(0);

    const e1 = { text: "Inject deps", score: 3 };
    const e2 = { text: "Use DI", score: 2 };
    const merged = applyMerges([e1, e2], [{ keep: e1, merge: e2, similarity: 0.5 }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ text: "Inject deps", score: 5 });
  });

  it("compacts a real core file and is a safe no-op otherwise", () => {
    const projectFiles = harness.state.projectFiles;
    const failReads = harness.state.failReads;
    const relPath = `wiki/projects/${SLUG}/core.md`;
    projectFiles.set(
      relPath,
      [
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
        "- Use dependency injection to wire all services<!--score:4-->",
        "- Use dependency injection for wiring every module<!--score:2-->",
        "- Write tests before implementing features<!--score:1-->",
        "",
        "## Watch-outs",
        "- Avoid: guess without verifying<!--score:1-->",
        "",
      ].join("\n"),
    );
    expect(compactCoreFile(harness.scratch.vault, SLUG, 0.45)).toBe(1);
    const compacted = projectFiles.get(relPath) ?? "";
    expect(compacted).toContain("Use dependency injection");
    const parsed = parseCoreFile(compacted);
    expect(parsed.learnings).toHaveLength(2);
    expect(parsed.watchouts).toHaveLength(1);

    projectFiles.set(
      relPath,
      [
        "---",
        "type: project-core",
        `project: ${SLUG}`,
        "created: 2026-08-07",
        "updated: 2026-08-07",
        "---",
        "",
        "## High-value learnings",
        "- Use DI<!--score:3-->",
        "- Write tests<!--score:1-->",
        "",
      ].join("\n"),
    );
    const before = projectFiles.get(relPath);
    expect(compactCoreFile(harness.scratch.vault, SLUG, 0.95)).toBe(0);
    expect(projectFiles.get(relPath)).toBe(before);

    projectFiles.delete(relPath);
    expect(compactCoreFile(harness.scratch.vault, SLUG, 0.5)).toBe(0);

    projectFiles.set(relPath, "existing");
    failReads.set(relPath, "Error: boom");
    expect(compactCoreFile(harness.scratch.vault, SLUG, 0.5)).toBeNull();
    failReads.delete(relPath);
  });
});

describe("cross-project promotion sweep", () => {
  const harness = useIntegrationHarness();

  it("counts normalized spread across projects", () => {
    const projects = {
      alpha: ["Use DI", "Pin deps"],
      beta: ["Use DI", "pin  deps", "Single only"],
    };
    expect(findCrossProjectEntries(projects, 2).sort()).toEqual(["Pin deps", "Use DI"]);
    expect(findCrossProjectEntries(projects, 3)).toHaveLength(0);
    expect(findCrossProjectEntries({ alpha: ["Use DI"], beta: ["Other"] }, 2)).toHaveLength(0);
    expect(findCrossProjectEntries({ alpha: ["Use DI", "Use DI"], beta: ["Use DI"] }, 2)).toHaveLength(1);
  });

  it("promotes idempotently with provenance and skips failures", () => {
    const projectFiles = harness.state.projectFiles;
    const failReads = harness.state.failReads;
    const vault = harness.scratch.vault;
    const projectsRoot = join(vault, "wiki", "projects");
    mkdirSync(join(projectsRoot, "sweep-a", "daily"), { recursive: true });
    mkdirSync(join(projectsRoot, "sweep-b", "daily"), { recursive: true });
    try {
      projectFiles.set(
        "wiki/projects/sweep-a/core.md",
        [
          "---",
          "type: project-core",
          "project: sweep-a",
          "created: 2026-08-07",
          "updated: 2026-08-07",
          "---",
          "",
          "# Project Learnings — sweep-a",
          "",
          "## High-value learnings",
          "- Use DI<!--score:2-->",
          "- Pin deps<!--score:1-->",
          "",
          "## Watch-outs",
          "- Avoid: guess<!--score:1-->",
          "",
        ].join("\n"),
      );
      projectFiles.set(
        "wiki/projects/sweep-b/core.md",
        [
          "---",
          "type: project-core",
          "project: sweep-b",
          "created: 2026-08-07",
          "updated: 2026-08-07",
          "---",
          "",
          "## High-value learnings",
          "- Use DI<!--score:1-->",
          "- Pin deps<!--score:1-->",
          "- Single only<!--score:1-->",
          "",
        ].join("\n"),
      );
      projectFiles.delete("wiki/global-core.md");

      expect(sweepPromoteGlobal(vault, 2).promoted).toBe(2);
      const g = projectFiles.get("wiki/global-core.md") ?? "";
      expect(g).toContain("- Use DI<!--from:sweep-a,sweep-b--><!--score:1-->");
      expect(g).toContain("- Pin deps<!--from:sweep-a,sweep-b--><!--score:1-->");
      expect(g).not.toContain("Single only");
      expect(g).not.toContain("Avoid: guess");

      const before = projectFiles.get("wiki/global-core.md");
      expect(sweepPromoteGlobal(vault, 2).promoted).toBe(0);
      expect(projectFiles.get("wiki/global-core.md")).toBe(before);

      expect(sweepPromoteGlobal(vault, 3).promoted).toBe(0);

      failReads.set("wiki/projects/sweep-b/core.md", "Error: boom");
      expect(sweepPromoteGlobal(vault, 2).promoted).toBe(0);
      failReads.delete("wiki/projects/sweep-b/core.md");
    } finally {
      rmSync(projectsRoot, { recursive: true, force: true });
      projectFiles.delete("wiki/global-core.md");
      projectFiles.delete("wiki/projects/sweep-a/core.md");
      projectFiles.delete("wiki/projects/sweep-b/core.md");
    }
    expect(sweepPromoteGlobal(vault, 2).promoted).toBe(0);
  });
});
