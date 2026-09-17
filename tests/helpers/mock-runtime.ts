import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Runtime, SpawnSyncResult } from "../../extensions/runtime";

export interface SpawnRecord {
  command: string;
  args: string[];
}

export interface MockRuntimeState {
  /** Every `exec` command issued, in order. */
  execCalls: string[];
  /** Every `spawn` invocation. */
  spawnCalls: SpawnRecord[];
  /** Every `spawnSync` command issued (joined argv). */
  spawnSyncCalls: string[];
  /** Stateful simulation of wiki/projects/<slug>/core.md + wiki/global-core.md. */
  projectFiles: Map<string, string>;
  /** Simulated obsidian read failures keyed by vault-relative path (error stdout). */
  failReads: Map<string, string>;
  /** Queue served by `git remote get-url origin`. */
  gitUrlQueue: string[];
  hotContent: string;
  indexContent: string;
  /** Queue consumed by the fake `spawn` subagent. */
  spawnOutputs: string[];
}

export interface MockRuntime {
  runtime: Runtime;
  state: MockRuntimeState;
}

/** Decode the shell-escaped `content="..."` argument back to text. */
export const decodeShell = (s: string): string => s.replace(/\\n/g, "\n").replace(/\\"/g, '"');

/**
 * Fake runtime backed by an in-memory vault. Records every command so tests can
 * assert intent, and serves canned/stateful outputs — no node built-in is
 * monkey-patched.
 */
export function createMockRuntime(): MockRuntime {
  const state: MockRuntimeState = {
    execCalls: [],
    spawnCalls: [],
    spawnSyncCalls: [],
    projectFiles: new Map(),
    failReads: new Map(),
    gitUrlQueue: [],
    hotContent: "hot cache injected\n",
    indexContent: "# wiki index injected\n",
    spawnOutputs: [],
  };

  const runtime: Runtime = {
    exec(command, _options) {
      const c = String(command);
      state.execCalls.push(c);
      if (c.includes("git remote get-url origin")) return state.gitUrlQueue.shift() ?? "";
      if (c.includes("path=wiki/hot.md")) return state.hotContent;
      if (c.includes("path=wiki/index.md")) return state.indexContent;

      const coreRead = c.match(/read "?path=(wiki\/(?:projects\/[^\s"]+|global-core\.md))/);
      if (coreRead) {
        if (state.failReads.has(coreRead[1])) {
          const err = new Error(`mock read failure: ${coreRead[1]}`);
          (err as Error & { stdout: string }).stdout = state.failReads.get(coreRead[1]) as string;
          throw err;
        }
        return state.projectFiles.get(coreRead[1]) ?? "";
      }

      const coreCreate = c.match(
        /create path=(wiki\/(?:projects\/[^\s"]+|global-core\.md)) overwrite=true content="((?:[^"\\]|\\.)*)"/,
      );
      if (coreCreate) {
        state.projectFiles.set(coreCreate[1], decodeShell(coreCreate[2]));
        return `Created: ${coreCreate[1]}\n`;
      }

      return "";
    },

    spawnSync(command, args, _options): SpawnSyncResult {
      state.spawnSyncCalls.push([command, ...args].join(" "));
      if (args.includes("wiki/hot.md")) {
        // args = ["-C", vaultPath, "checkout", "HEAD", "--", "wiki/hot.md"]
        writeFileSync(join(args[1], "wiki", "hot.md"), "hot cache restored\n");
      }
      return { status: 0, stdout: "", stderr: "" };
    },

    spawn(command, args, _options): ChildProcess {
      state.spawnCalls.push({ command, args: [...args] });
      const handlers: Record<string, (arg?: unknown) => void> = {};
      const child = {
        stdout: {
          on: (event: string, fn: (arg?: unknown) => void) => {
            if (event === "data") handlers.stdout = fn;
          },
        },
        stderr: {
          on: (event: string, fn: (arg?: unknown) => void) => {
            if (event === "data") handlers.stderr = fn;
          },
        },
        on: (event: string, fn: (arg?: unknown) => void) => {
          handlers[event] = fn;
        },
        kill: () => {},
      };
      setTimeout(() => {
        const text = state.spawnOutputs.shift() ?? "generated output";
        handlers.stdout?.(
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text }] },
          }) + "\n",
        );
        handlers.close?.(0);
      }, 0);
      return child as unknown as ChildProcess;
    },
  };

  return { runtime, state };
}