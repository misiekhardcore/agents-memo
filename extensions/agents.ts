/**
 * memo_dispatch tool - delegate tasks to the vault's specialized agents.
 *
 * Loads agent definitions from <pluginRoot>/agents/*.md (frontmatter + body),
 * converts Claude Code agent frontmatter to pi tool configuration, and spawns
 * isolated `pi` subprocesses in JSON mode. Supports single, parallel, and
 * chain execution modes.
 *
 * Frontmatter conversion (AC19):
 *   - permissions + disallowedTools → tools allowlist (disallowedTools wins
 *     over permissions; "Agent" is always dropped; web tools survive when
 *     allowed; memo_dispatch is opt-in via `- memo_dispatch: 'allow'` and
 *     granted only to orchestrator agents that dispatch sub-agents)
 *   - model mapping: haiku → deepseek-v4-flash, sonnet → deepseek-v4-pro
 *   - maxTurns / background are ignored (pi has no per-agent turn cap; JSON
 *     mode output is already collapsed)
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = join(pluginRoot, "agents");

// ─── Agent discovery ──────────────────────────────────────────────────────────
export interface AgentConfig {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  systemPrompt: string;
  filePath: string;
}

// Claude Code tool names (as written in agent frontmatter) → pi tool names.
// Everything is normalized to the pi name before allowlisting/negation, so
// `disallowedTools: WebFetch WebSearch Glob Grep` and
// `permissions: - webfetch: 'allow'` both resolve to pi tool names.
const TOOL_NAME_MAP: Record<string, string> = {
  bash: "bash",
  read: "read",
  write: "write",
  edit: "edit",
  ls: "ls",
  grep: "grep",
  find: "find",
  glob: "grep",
  webfetch: "web_fetch",
  websearch: "web_search",
  memo_dispatch: "memo_dispatch",
};

// Tools pi actually provides. Expanded beyond the bash/read/edit/ls/grep/find
// core so permission-allowlisted web tools (research-round's webfetch/websearch)
// survive the final filter instead of being silently dropped, and so
// research-round can dispatch source-synth agents via memo_dispatch.
const KNOWN_TOOLS = [
  "bash", "read", "write", "edit", "ls", "grep", "find",
  "web_fetch", "web_search", "memo_dispatch",
];

const MODEL_MAP: Record<string, string> = {
  haiku: "deepseek-v4-flash",
  sonnet: "deepseek-v4-pro",
};

function normalizeToolName(name: string): string {
  return TOOL_NAME_MAP[name.toLowerCase()] ?? name.toLowerCase();
}

interface Frontmatter {
  [key: string]: string | string[] | number | boolean | undefined;
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { frontmatter: {}, body: content };
  const fm: Frontmatter = {};
  const lines = m[1].split(/\r?\n/);
  let key: string | null = null;
  for (const line of lines) {
    if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(line)) {
      const idx = line.indexOf(":");
      key = line.slice(0, idx).trim();
      const raw = line.slice(idx + 1).trim();
      fm[key] = raw.length > 0 ? raw : undefined;
    } else if (key && /^\s+-\s+/.test(line)) {
      const item = line.trim().replace(/^-\s+/, "");
      const existing = fm[key];
      if (Array.isArray(existing)) existing.push(item);
      else if (typeof existing === "string") fm[key] = [existing, item];
      else fm[key] = [item];
    }
  }
  return { frontmatter: fm, body: content.slice(m[0].length) };
}

function toList(value: string | string[] | number | boolean | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map(String);
  return String(value).split(/[\s,]+/).filter(Boolean);
}

export function buildToolAllowlist(fm: Frontmatter): string[] {
  const disallowed = new Set(toList(fm.disallowedTools).map(normalizeToolName));
  const tools = new Set<string>();

  // Permissions: `- bash: 'allow'` entries name tools explicitly allowed.
  for (const item of toList(fm.permissions)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*['"]?(\w+)['"]?/.exec(item);
    if (m && m[2].toLowerCase() === "allow") {
      const t = normalizeToolName(m[1]);
      if (KNOWN_TOOLS.includes(t)) tools.add(t);
    }
  }

  // Default set: every known tool except memo_dispatch. Dispatching sub-agents
  // is opt-in - only orchestrator agents (research-round) that list
  // `memo_dispatch: 'allow'` in permissions get it; leaf agents do not.
  for (const t of KNOWN_TOOLS) {
    if (t === "memo_dispatch") continue;
    tools.add(t);
  }

  // disallowedTools is a strict subtraction and wins over permissions: a tool
  // in both permissions and disallowedTools is rejected.
  for (const t of disallowed) tools.delete(t);

  return [...tools].filter((t) => KNOWN_TOOLS.includes(t));
}

function mapModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return MODEL_MAP[model.toLowerCase()] ?? model;
}

export function loadAgents(): AgentConfig[] {
  const agents: AgentConfig[] = [];
  let entries: string[];
  try {
    entries = readdirSync(AGENTS_DIR);
  } catch {
    return agents;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    let content: string;
    try {
      content = readFileSync(join(AGENTS_DIR, entry), "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(content);
    const name = typeof frontmatter.name === "string" ? frontmatter.name : "";
    const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
    if (!name || !description) continue;
    agents.push({
      name,
      description,
      tools: buildToolAllowlist(frontmatter),
      model: mapModel(typeof frontmatter.model === "string" ? frontmatter.model : undefined),
      systemPrompt: body.trim(),
      filePath: join(AGENTS_DIR, entry),
    });
  }
  return agents;
}

// ─── Subprocess execution ─────────────────────────────────────────────────────
interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;
  output: string;
  stderr: string;
  model?: string;
  step?: number;
}

function finalText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown } | undefined;
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content as Array<{ type?: string; text?: string }>) {
        if (part?.type === "text") return part.text ?? "";
      }
    }
  }
  return "";
}

// Re-invoke the running pi binary (mirrors the subagent example): when the
// process runs from a real script (npm install), spawn `node cli.js ...`;
// when it's a compiled binary, spawn the binary itself; otherwise use PATH.
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

function runPiSubprocess(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: { text: string }) => void) | undefined,
): Promise<SingleResult> {
  return new Promise((resolvePromise) => {
    const { command, args: cmdArgs } = getPiInvocation(args);
    const child = spawn(command, cmdArgs, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    let stderr = "";
    const messages: unknown[] = [];

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: { type?: string; message?: unknown };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "message_end" && event.message) {
        messages.push(event.message);
        onUpdate?.({ text: finalText(messages) || "(running...)" });
      }
    };

    child.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("close", (code: number | null) => {
      if (buffer.trim()) processLine(buffer);
      resolvePromise({
        agent: "",
        task: "",
        exitCode: code ?? 0,
        output: finalText(messages),
        stderr,
      });
    });
    child.on("error", () => {
      resolvePromise({ agent: "", task: "", exitCode: 1, output: "", stderr: "failed to spawn pi", step: undefined });
    });

    if (signal) {
      const killProc = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
      };
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }
  });
}

function formatResults(results: SingleResult[]): string {
  const parts: string[] = [];
  for (const r of results) {
    const status = r.exitCode === 0 ? "ok" : `exit ${r.exitCode}`;
    parts.push(`### ${r.agent || "(unknown agent)"} [${status}]`);
    if (r.model) parts.push(`model: ${r.model}`);
    const body = r.output || r.stderr || "(no output)";
    parts.push(body.trim());
  }
  return parts.join("\n\n");
}

// ─── Tool registration ────────────────────────────────────────────────────────
export function registerMemoDispatchTool(pi: ExtensionAPI): void {
  const agents = loadAgents();
  const agentNames = agents.map((a) => a.name);
  const agentDescriptions = agents.map((a) => `${a.name}: ${a.description}`).join("\n");

  pi.registerTool({
    name: "memo_dispatch",
    label: "Memo Dispatch",
    description:
      "Delegate tasks to specialized vault agents. " +
      `Available agents:\n${agentDescriptions}\n` +
      "Modes: single {agent, task}; parallel {tasks: [{agent, task}]}; chain {chain: [{agent, task}]} where {previous} in a later task is replaced with the prior step's output.",
    promptSnippet: "memo_dispatch: delegate vault work to specialized agents",
    parameters: Type.Union([
      Type.Object({
        agent: Type.String({ description: "Agent name to run (single mode)" }),
        task: Type.String({ description: "Task to delegate" }),
        cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
      }),
      Type.Object({
        tasks: Type.Array(
          Type.Object({
            agent: Type.String({ description: "Agent name" }),
            task: Type.String({ description: "Task for this agent" }),
          }),
          { description: "Tasks to run in parallel" },
        ),
        cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
      }),
      Type.Object({
        chain: Type.Array(
          Type.Object({
            agent: Type.String({ description: "Agent name" }),
            task: Type.String({ description: "Task; {previous} is replaced with the prior step's output" }),
          }),
          { description: "Sequential steps; each step's output feeds the next via {previous}" },
        ),
        cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
      }),
    ]),
    async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const cwd = "cwd" in params && typeof params.cwd === "string" ? params.cwd : ctx.cwd;

      const runOne = (agentName: string, task: string, step?: number): Promise<SingleResult> => {
        const agent = agents.find((a) => a.name === agentName);
        if (!agent) {
          return Promise.resolve({
            agent: agentName,
            task,
            exitCode: 1,
            output: "",
            stderr: `Unknown agent "${agentName}". Available: ${agentNames.join(", ") || "none"}.`,
            step,
          });
        }
        const args: string[] = ["--mode", "json", "-p", "--no-session"];
        if (agent.model) args.push("--model", agent.model);
        if (agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
        if (agent.systemPrompt) args.push("--system-prompt", agent.systemPrompt);
        args.push(`Task: ${task}`);
        return runPiSubprocess(args, cwd, signal, (partial) => {
          onUpdate?.({
            content: [{ type: "text", text: partial.text }],
            details: {},
          });
        }).then((r) => ({ ...r, agent: agentName, task, model: r.model ?? agent.model, step }));
      };

      // single
      if ("agent" in params) {
        const r = await runOne(params.agent, params.task);
        return {
          content: [{ type: "text", text: formatResults([r]) }],
          details: { mode: "single", results: [r] },
        };
      }

      // parallel
      if ("tasks" in params) {
        const results = await Promise.all(
          params.tasks.map((t, i) => runOne(t.agent, t.task, i + 1)),
        );
        return {
          content: [{ type: "text", text: formatResults(results) }],
          details: { mode: "parallel", results },
        };
      }

      // chain: {previous} in later tasks is replaced with the previous output.
      // The replacer MUST be the arrow-function form: a string replacement
      // would interpret $-patterns ($&, $', $`, $1-$99) in subagent output
      // as special substitution tokens and mangle the next task.
      const results: SingleResult[] = [];
      let previous = "";
      for (let i = 0; i < params.chain.length; i++) {
        const step = params.chain[i];
        const task = previous ? step.task.replace(/\{previous\}/g, () => previous) : step.task;
        const r = await runOne(step.agent, task, i + 1);
        results.push(r);
        previous = r.output || r.stderr;
      }
      return {
        content: [{ type: "text", text: formatResults(results) }],
        details: { mode: "chain", results },
      };
    },
  });
}

// Standalone entry point so pi can load this file directly (extensions/*.ts).
export default function (pi: ExtensionAPI): void {
  registerMemoDispatchTool(pi);
}
