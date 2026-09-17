import { afterEach, beforeEach } from "vitest";
import { resetObsidianState } from "../../extensions/obsidian";
import { resetRuntime, setRuntime } from "../../extensions/runtime";
import { createMockPi, type MockPi, type MockPiOptions } from "./mock-pi";
import { createMockRuntime, type MockRuntime } from "./mock-runtime";
import { createScratch, writePiSettings, type Scratch } from "./scratch";

/** Baseline global settings shared by integration suites. */
export function defaultSettings(vaultPath: string) {
  return {
    vaultPath,
    bootstrapReadHot: "always" as const,
    bootstrapReadIndex: "on-demand" as const,
    autoCommit: true,
    reflectModel: { provider: "deepseek", id: "deepseek-v4-flash" },
  };
}

/**
 * Per-test integration fixture: scratch HOME+vault, fake runtime bound to the
 * extension port, and reset module state. Every test file gets isolated module
 * registries, and every test gets fresh fs + runtime state.
 */
export function useIntegrationHarness() {
  let scratch: Scratch;
  let runtimeMock: MockRuntime;

  beforeEach(() => {
    scratch = createScratch();
    runtimeMock = createMockRuntime();
    setRuntime(runtimeMock.runtime);
    process.env.HOME = scratch.home;
    resetObsidianState();
    writePiSettings(scratch.home, defaultSettings(scratch.vault));
  });

  afterEach(() => {
    resetRuntime();
    resetObsidianState();
    scratch.cleanup();
  });

  return {
    get scratch() {
      return scratch;
    },
    get state() {
      return runtimeMock.state;
    },
    get runtime() {
      return runtimeMock.runtime;
    },
  };
}

/** Create a mock pi bound to the scratch vault as its cwd. */
export function mountPi(harness: { scratch: Scratch }, options: MockPiOptions = {}): MockPi {
  return createMockPi({ cwd: harness.scratch.vault, ...options });
}
