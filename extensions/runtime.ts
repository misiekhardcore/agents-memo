/**
 * Runtime port — the single seam through which the extension touches the OS:
 * shell execution (obsidian-cli.sh, git, mkdir) and subprocess spawning.
 *
 * Production binds {@link systemRuntime} (node:child_process). Tests bind a
 * fake through {@link setRuntime} so no test ever monkey-patches a node
 * built-in. The port is a module-level singleton because every consumer is
 * synchronous and tests run serially within a file; vitest isolates test files
 * into separate module registries, so no state leaks across files.
 */

import {
  execSync,
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type ExecSyncOptions,
  type SpawnOptions,
  type SpawnSyncOptions,
} from "node:child_process";

export interface SpawnSyncResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Runtime {
  /** Synchronous command execution; callers always pass `encoding: "utf-8"`. */
  exec(command: string, options?: ExecSyncOptions): string;
  /** Synchronous spawn for the hot-cache restore (no shell interpolation). */
  spawnSync(command: string, args: string[], options?: SpawnSyncOptions): SpawnSyncResult;
  /** Async spawn for memo_dispatch subagents. */
  spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess;
}

export const systemRuntime: Runtime = {
  exec(command, options) {
    return execSync(command, options) as string;
  },
  spawnSync(command, args, options) {
    const result = nodeSpawnSync(command, args, options);
    return {
      status: result.status,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  },
  spawn(command, args, options) {
    return nodeSpawn(command, args, options ?? {});
  },
};

let active: Runtime = systemRuntime;

export function getRuntime(): Runtime {
  return active;
}

export function setRuntime(runtime: Runtime): void {
  active = runtime;
}

export function resetRuntime(): void {
  active = systemRuntime;
}
