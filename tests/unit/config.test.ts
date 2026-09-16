import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPiSettings } from "../../extensions/config";
import { resolveVaultPath } from "../../extensions/obsidian";
import { useIntegrationHarness } from "../helpers/integration";
import { writePiSettings, writeProjectSettings } from "../helpers/scratch";

describe("readPiSettings nested-block merge + defaults", () => {
  const harness = useIntegrationHarness();

  it("applies defaults and per-key first-wins across tiers", () => {
    const projCwd = join(harness.scratch.root, "cfg-cwd");
    mkdirSync(projCwd, { recursive: true });
    writePiSettings(harness.scratch.home, { vaultPath: harness.scratch.vault });
    writeProjectSettings(projCwd, {});
    let cfg = readPiSettings(projCwd);
    expect(cfg.vaultPath).toBe(harness.scratch.vault);
    expect(cfg.projectMemory?.enabled).toBe(true);
    expect(cfg.projectMemory?.globalEnabled).toBe(true);
    expect(cfg.projectMemory?.maxGlobalItems).toBe(20);
    expect(cfg.projectMemory?.promotionThreshold).toBe(2);
    expect(cfg.projectMemory?.reflectUntouchedRuns).toBe(true);
    expect(cfg.memoryInjection?.sessionStart).toBe(true);
    expect(cfg.memoryInjection?.reInjectOnCompact).toBe(true);
    expect(cfg.memoryInjection?.digestBudgetChars).toBe(800);
    expect(cfg.memoryInjection?.projectCoreTop).toBe(5);
    expect(cfg.memoryInjection?.globalCoreTop).toBe(5);
    expect(cfg.pageCandidacy?.threshold).toBe(3);

    // Global wins every key it defines; project only fills undefined keys.
    writePiSettings(harness.scratch.home, {
      projectMemory: { globalEnabled: false, promotionThreshold: 3 },
    });
    writeProjectSettings(projCwd, {
      projectMemory: { globalEnabled: true, maxGlobalItems: 7, reflectUntouchedRuns: false },
    });
    cfg = readPiSettings(projCwd);
    expect(cfg.projectMemory?.globalEnabled).toBe(false);
    expect(cfg.projectMemory?.promotionThreshold).toBe(3);
    expect(cfg.projectMemory?.maxGlobalItems).toBe(7);
    expect(cfg.projectMemory?.reflectUntouchedRuns).toBe(false);
    expect(cfg.projectMemory?.enabled).toBe(true);

    writePiSettings(harness.scratch.home, { memoryInjection: { digestBudgetChars: 1200 } });
    writeProjectSettings(projCwd, {
      memoryInjection: { sessionStart: false, digestBudgetChars: 500 },
      pageCandidacy: { threshold: 5 },
    });
    cfg = readPiSettings(projCwd);
    expect(cfg.memoryInjection?.digestBudgetChars).toBe(1200);
    expect(cfg.memoryInjection?.sessionStart).toBe(false);
    expect(cfg.memoryInjection?.reInjectOnCompact).toBe(true);
    expect(cfg.pageCandidacy?.threshold).toBe(5);
  });

  it("type-gates malformed values and numeric holes to defaults", () => {
    const projCwd = join(harness.scratch.root, "cfg-cwd2");
    mkdirSync(projCwd, { recursive: true });
    writePiSettings(harness.scratch.home, {
      projectMemory: { maxGlobalItems: "many" },
      pageCandidacy: { threshold: "high" },
    });
    writeProjectSettings(projCwd, {});
    let cfg = readPiSettings(projCwd);
    expect(cfg.projectMemory?.maxGlobalItems).toBe(20);
    expect(cfg.pageCandidacy?.threshold).toBe(3);

    // JSON.parse accepts 1e999 (→ Infinity); negatives pass typeof number.
    writePiSettings(harness.scratch.home, {
      memoryInjection: { digestBudgetChars: 1e999, projectCoreTop: -3, globalCoreTop: 2.5 },
    });
    cfg = readPiSettings(projCwd);
    expect(cfg.memoryInjection?.digestBudgetChars).toBe(800);
    expect(cfg.memoryInjection?.projectCoreTop).toBe(5);
    expect(cfg.memoryInjection?.globalCoreTop).toBe(5);

    writePiSettings(harness.scratch.home, {
      projectMemory: { promotionThreshold: -1 },
      pageCandidacy: { threshold: 0 },
    });
    cfg = readPiSettings(projCwd);
    expect(cfg.projectMemory?.promotionThreshold).toBe(2);
    expect(cfg.pageCandidacy?.threshold).toBe(0);
  });

  it("validates similarity/auto-compact thresholds", () => {
    const projCwd = join(harness.scratch.root, "cfg-cwd3");
    mkdirSync(projCwd, { recursive: true });
    writePiSettings(harness.scratch.home, { similarityThreshold: 2.5, autoCompactThreshold: -0.1 });
    let cfg = readPiSettings(projCwd);
    expect(cfg.similarityThreshold).toBe(0.7);
    expect(cfg.autoCompactThreshold).toBe(0.85);

    writePiSettings(harness.scratch.home, { similarityThreshold: 0.5, autoCompactThreshold: 0.9 });
    cfg = readPiSettings(projCwd);
    expect(cfg.similarityThreshold).toBe(0.5);
    expect(cfg.autoCompactThreshold).toBe(0.9);
  });
});

describe("resolveVaultPath Claude settings tiers", () => {
  const harness = useIntegrationHarness();

  it("honors claude settings with fallthrough for stale paths", () => {
    const claudeVault = join(harness.scratch.home, "claude-vault");
    mkdirSync(claudeVault, { recursive: true });
    mkdirSync(join(harness.scratch.home, ".claude"), { recursive: true });
    const writeClaude = (file: string, vaultPath: string) =>
      writeFileSync(
        join(harness.scratch.home, ".claude", file),
        JSON.stringify({ pluginConfigs: { "claude-code-agents-memo": { options: { vault_path: vaultPath } } } }),
      );

    // No vaultPath anywhere in pi settings so the Claude tier is reached.
    writePiSettings(harness.scratch.home, {});
    writeClaude("settings.json", "~/claude-vault");
    expect(resolveVaultPath()).toBe(claudeVault);

    writeClaude("settings.json", "~/stale-claude-vault");
    expect(resolveVaultPath()).toBeNull();

    // A stale settings.local.json must not shadow a valid settings.json.
    writeClaude("settings.local.json", "~/stale-local");
    writeClaude("settings.json", "~/claude-vault");
    expect(resolveVaultPath()).toBe(claudeVault);
  });
});