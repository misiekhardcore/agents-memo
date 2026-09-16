import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (the worktree running vitest). */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface Scratch {
  root: string;
  home: string;
  vault: string;
  cleanup: () => void;
}

/**
 * Hermetic scratch environment: a throwaway HOME (so pi/claude settings
 * resolution never sees the developer's real config) and a throwaway vault with
 * the minimal wiki skeleton. Tests set `process.env.HOME` to `home`.
 */
export function createScratch(prefix = "agents-memo-test-"): Scratch {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const vault = join(root, "vault");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  for (const dir of ["wiki", ".raw", "notes"]) mkdirSync(join(vault, dir), { recursive: true });
  writeFileSync(join(vault, "wiki", "hot.md"), "hot cache v1\n");
  writeFileSync(join(vault, "wiki", "index.md"), "# index\n");
  writeFileSync(join(vault, ".raw", "sample.md"), "# raw\n");
  return {
    root,
    home,
    vault,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface PiSettingsOptions {
  vaultPath?: string;
  [key: string]: unknown;
}

/** Write the scratch global pi settings file. */
export function writePiSettings(home: string, agentsMemo: PiSettingsOptions): void {
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "settings.json"),
    JSON.stringify({ agentsMemo }),
  );
}

/** Write a project-local `.pi/settings.json` under `cwd`. */
export function writeProjectSettings(cwd: string, agentsMemo: PiSettingsOptions): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ agentsMemo }));
}