import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { REPO } from "./scratch";

export type GitDirty = boolean | "wiki" | "obsidian";

export interface CompleteCall {
  model: unknown;
  context: unknown;
  options: unknown;
}

export interface MockModelRegistry {
  find?: (provider: string, id: string) => unknown;
  getApiKeyAndHeaders?: (model: unknown) => Promise<{ ok: boolean; apiKey?: string; error?: string }>;
  complete?: (model: unknown, context: unknown, options: unknown) => Promise<unknown>;
}

export interface MockPi {
  pi: ExtensionAPI;
  handlers: Record<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
  tools: Array<Record<string, unknown>>;
  commands: Array<{ name: string; opts: { description?: string; handler?: unknown } }>;
  sent: Array<{ msg: { customType?: string; content: string; display?: boolean }; opts?: unknown }>;
  execs: string[][];
  completeCalls: CompleteCall[];
  modelRegistry: MockModelRegistry;
  ctx: {
    hasUI: boolean;
    cwd: string;
    ui: {
      notify: (message: string, type?: string) => void;
      setWorkingMessage: (message?: string) => void;
      input: () => Promise<string | undefined>;
      confirm: () => Promise<boolean>;
    };
    modelRegistry: MockModelRegistry;
    model: unknown;
  };
  setGitDirty: (dirty: GitDirty) => void;
  setGitCommitCode: (code: number) => void;
  setGitPushCode: (code: number) => void;
  notifyCount: () => number;
  workingMessages: () => Array<string | null>;
}

export interface MockPiOptions {
  cwd?: string;
  /** Canned registry.complete payload; defaults to a reflection JSON. */
  completeResult?: unknown;
}

/**
 * Mock ExtensionAPI + ExtensionContext. The model registry exposes `complete`
 * (the real ModelRegistry method) so the reflection pipeline is exercised
 * end-to-end without a model.
 */
export function createMockPi(options: MockPiOptions = {}): MockPi {
  const handlers: Record<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>> = {};
  const tools: Array<Record<string, unknown>> = [];
  const commands: MockPi["commands"] = [];
  const sent: MockPi["sent"] = [];
  const execs: string[][] = [];
  const completeCalls: CompleteCall[] = [];

  let gitDirty: GitDirty = false;
  let gitCommitCode = 0;
  let gitPushCode = 0;
  let notifyCount = 0;
  const workingMessages: Array<string | null> = [];
  const dirts: Record<string, string> = {
    wiki: " M wiki/hot.md\n",
    obsidian: " M .obsidian/workspace.json\n",
  };

  const completeResult =
    options.completeResult ??
    JSON.stringify({ mistakes: ["m1", "m2"], fixes: ["f1", "f2"] });

  const modelRegistry: MockModelRegistry = {
    find: (provider, id) => ({ provider, id }),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "mock-key" }),
    complete: async (model, context, completeOptions) => {
      completeCalls.push({ model, context, options: completeOptions });
      return { role: "assistant", content: [{ type: "text", text: String(completeResult) }] };
    },
  };

  const ctx: MockPi["ctx"] = {
    hasUI: true,
    cwd: options.cwd ?? REPO,
    ui: {
      notify: () => {
        notifyCount++;
      },
      setWorkingMessage: (message?: string) => {
        workingMessages.push(message ?? null);
      },
      input: async () => undefined,
      confirm: async () => false,
    },
    modelRegistry,
    model: undefined,
  };

  const pi = {
    on(event: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) {
      (handlers[event] ??= []).push(fn);
    },
    registerTool(tool: Record<string, unknown>) {
      tools.push(tool);
    },
    registerCommand(name: string, opts: { description?: string; handler?: unknown }) {
      commands.push({ name, opts });
    },
    sendMessage(msg: MockPi["sent"][number]["msg"], opts?: unknown) {
      sent.push({ msg, opts });
    },
    exec(cmd: string, args: string[]) {
      execs.push([cmd, ...args]);
      if (cmd === "git" && args[2] === "status") {
        const dirt = dirts[gitDirty as string] ?? "";
        // git status --porcelain -- wiki/ .raw/ suppresses out-of-scope dirt.
        const scoped = args.includes("--") && args.includes("wiki/") && args.includes(".raw/");
        const visible = scoped ? (gitDirty === "wiki" ? dirt : "") : dirt;
        return Promise.resolve({ code: 0, stdout: visible });
      }
      if (cmd === "git" && args.includes("commit")) {
        return Promise.resolve({ code: gitCommitCode, stdout: "" });
      }
      if (cmd === "git" && args.includes("push")) {
        return Promise.resolve({ code: gitPushCode, stdout: "" });
      }
      return Promise.resolve({ code: 0, stdout: "" });
    },
  };

  return {
    pi: pi as unknown as ExtensionAPI,
    handlers,
    tools,
    commands,
    sent,
    execs,
    completeCalls,
    modelRegistry,
    ctx,
    setGitDirty: (dirty) => {
      gitDirty = dirty;
    },
    setGitCommitCode: (code) => {
      gitCommitCode = code;
    },
    setGitPushCode: (code) => {
      gitPushCode = code;
    },
    notifyCount: () => notifyCount,
    workingMessages: () => workingMessages,
  };
}