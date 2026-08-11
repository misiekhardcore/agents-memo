#!/usr/bin/env node
// Pi extension regression smoke (issue objective §9.10).
//
// Imports extensions/agents-memo.ts and extensions/agents.ts via jiti (the
// same loader pi uses) and drives their handlers with a mock ExtensionAPI.
// Hermetic by construction: scratch HOME + scratch vault under os.tmpdir,
// patched child_process.execSync/spawn, no Obsidian required.
//
// Coverage:
//   AC5-7   tool_call rewrite (MEMO_PLUGIN_PWD + leading obsidian) + daily overwrite block
//   AC12    vault I/O block + bypass allowlist
//   AC8-11  before_agent_start INIT/hot/index injection + session_compact re-injection
//   AC13    tool_execution_end hot-cache 0-byte guard
//   AC14-15 agent_settled auto-commit + notify
//   AC16-17 agent_end / session_shutdown reflection (write-verb touched tracking)
//   PM      per-project memory: slug derivation, bounded in-process
//           reflection (complete() mock via jiti alias), project daily +
//           core.md pipeline, legacy fallback, core.md parse/merge/render
//           pure functions, digest injection at before_agent_start + compact,
//           reflectUntouchedRuns gate, global core read-failure guard
//   AC18-21 memo_dispatch discovery, frontmatter conversion, single/parallel/chain, registration

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = mkdtempSync(join(tmpdir(), "agents-memo-smoke-"));
const HOME = join(SCRATCH, "home");
const VAULT = join(SCRATCH, "vault");

// ─── Hermetic environment: scratch HOME + vault (before importing the modules)
process.env.HOME = HOME;
mkdirSync(join(HOME, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(HOME, ".pi", "agent", "settings.json"),
  JSON.stringify({
    agentsMemo: {
      vaultPath: VAULT,
      bootstrapReadHot: "always",
      bootstrapReadIndex: "on-demand",
      autoCommit: true,
    },
  }),
);
for (const dir of ["wiki", ".raw", "notes"]) mkdirSync(join(VAULT, dir), { recursive: true });
writeFileSync(join(VAULT, "wiki", "hot.md"), "hot cache v1\n");
writeFileSync(join(VAULT, "wiki", "index.md"), "# index\n");
writeFileSync(join(VAULT, ".raw", "sample.md"), "# raw\n");

// ─── Patched child_process: record calls, serve canned outputs ──────────────
const cp = require("node:child_process");
const calls = { exec: [], spawn: [] };
const execFakes = {
  hot: "hot cache injected\n",
  index: "# wiki index injected\n",
};
// Stateful simulation of the wiki/projects/<slug>/ subtree + wiki/global-core.md
// (project + global memory): reads return what prior overwrites stored, so
// core merge/dedup/score can be asserted end-to-end without Obsidian. Content
// is shell-decoded the same way the real obsidian CLI round-trips literal \n
// → newline.
const projectFiles = new Map();
// Simulated obsidian read failures keyed by vault-relative path (value = the
// error's stdout). Lets the smoke test drive the missing-file classification
// ("Error: File ... not found.") and the read-failure guard without Obsidian.
const failReads = new Map();
// Queue of canned `git remote get-url origin` outputs (slug derivation). The
// extension's execSync binding is captured at import time, so the mock reads
// from this mutable state instead of being reassigned per test.
let gitUrlQueue = [];
const decodeShell = (s) => s.replace(/\\n/g, "\n").replace(/\\"/g, '"');
cp.execSync = (cmd) => {
  calls.exec.push(String(cmd));
  const c = String(cmd);
  if (c.includes("git remote get-url origin")) return gitUrlQueue.shift() ?? "";
  if (c.includes('path=wiki/hot.md')) return execFakes.hot;
  if (c.includes('path=wiki/index.md')) return execFakes.index;
  const coreRead = c.match(/read "?path=(wiki\/(?:projects\/[^\s"]+|global-core\.md))/);
  if (coreRead) {
    if (failReads.has(coreRead[1])) {
      const err = new Error(`mock read failure: ${coreRead[1]}`);
      err.stdout = failReads.get(coreRead[1]);
      throw err;
    }
    return projectFiles.get(coreRead[1]) ?? "";
  }
  const coreCreate = c.match(/create path=(wiki\/(?:projects\/[^\s"]+|global-core\.md)) overwrite=true content="((?:[^"\\]|\\.)*)"/);
  if (coreCreate) {
    projectFiles.set(coreCreate[1], decodeShell(coreCreate[2]));
    return `Created: ${coreCreate[1]}\n`;
  }
  if (c.includes("create-or-append")) return "";
  return "";
};
// Synchronous git restore used by the AC13 hot-cache guard (spawnSync — no
// shell interpolation of the vault path). The reflection no longer uses a pi
// subprocess (in-process complete() instead, mocked via the jiti alias below),
// so no canned pi --mode json branch is needed here.
cp.spawnSync = (command, args) => {
  calls.exec.push([command, ...args].join(" "));
  if (args.includes("wiki/hot.md")) {
    // simulate a successful git restore from HEAD
    writeFileSync(join(VAULT, "wiki", "hot.md"), "hot cache restored\n");
  }
  return { status: 0, stdout: "", stderr: "" };
};
// Fake pi subprocess for memo_dispatch: emits one assistant message_end then closes.
const spawnOutputs = ["first result", "second result"];
cp.spawn = (command, args, opts) => {
  calls.spawn.push({ command, args: [...args] });
  const handlers = {};
  const child = {
    stdout: { on: (ev, fn) => { handlers.stdout = ev === "data" ? fn : handlers.stdout; } },
    stderr: { on: (ev, fn) => { handlers.stderr = ev === "data" ? fn : handlers.stderr; } },
    on: (ev, fn) => { handlers[ev] = fn; },
    kill: () => {},
  };
  setTimeout(() => {
    const text = spawnOutputs.shift() ?? "generated output";
    handlers.stdout?.(JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }] },
    }) + "\n");
    handlers.close?.(0);
  }, 0);
  return child;
};

// ─── Assertion helpers ───────────────────────────────────────────────────────
let passCount = 0;
let failCount = 0;
function assert(cond, label) {
  if (cond) { passCount++; }
  else { failCount++; console.error(`  [FAIL] ${label}`); }
}
function section(name) { console.log(`\n=== ${name} ===`); }

// ─── Mock ExtensionAPI ───────────────────────────────────────────────────────
function createMockPi() {
  const handlers = {};
  const tools = [];
  const commands = [];
  const sent = [];
  const execs = [];
  // Models git's own pathspec filtering: dirt is reportable only when it is
  // in scope (wiki/ for the extension's scoped status, anything for a
  // whole-repo status). Modes: true/"wiki" → wiki dirt, "obsidian" →
  // .obsidian/workspace.json dirt (Obsidian's own churn), false → clean.
  let gitDirty = false;
  let gitCommitCode = 0;
  let notifyCount = 0;
  const workingMessages = [];
  const dirts = { wiki: " M wiki/hot.md\n", obsidian: " M .obsidian/workspace.json\n" };
  const pi = {
    on(event, fn) { (handlers[event] ??= []).push(fn); },
    registerTool(tool) { tools.push(tool); },
    registerCommand(name, opts) { commands.push({ name, opts }); },
    sendMessage(msg, opts) { sent.push({ msg, opts }); },
    exec(cmd, args) {
      execs.push([cmd, ...args]);
      if (cmd === "git" && args[2] === "status") {
        const dirt = dirts[gitDirty] ?? "";
        // git status --porcelain -- wiki/ .raw/ suppresses out-of-scope dirt.
        const scoped = args.includes("--") && args.includes("wiki/") && args.includes(".raw/");
        const visible = scoped ? (gitDirty === "wiki" ? dirt : "") : dirt;
        return Promise.resolve({ code: 0, stdout: visible });
      }
      if (cmd === "git" && args.includes("commit")) {
        // pi.exec resolves with {code} on failure (never throws) — the
        // handler must inspect it; "nothing to commit" exits 1.
        return Promise.resolve({ code: gitCommitCode, stdout: "" });
      }
      return Promise.resolve({ code: 0, stdout: "" });
    },
  };
  const ctx = {
    hasUI: true,
    cwd: REPO,
    ui: {
      notify: () => { notifyCount++; },
      setWorkingMessage: (msg) => { workingMessages.push(msg ?? null); },
    },
    modelRegistry: {
      find: () => ({ provider: "deepseek", id: "deepseek-v4-flash" }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "mock-key" }),
    },
    model: undefined,
  };
  return {
    pi, handlers, tools, commands, sent, execs,
    setGitDirty: (d) => { gitDirty = d === true ? "wiki" : d; },
    setGitCommitCode: (c) => { gitCommitCode = c; },
    notifyCount: () => notifyCount,
    workingMessages: () => workingMessages,
    ctx,
  };
}

// ─── Mock @mariozechner/pi-ai (reflection complete()) ────────────────────────
// The extension imports complete/getModel from @mariozechner/pi-ai, which pi's
// runtime resolves to its bundled compat entrypoint. For the hermetic smoke
// test the bare specifier is aliased (jiti alias) to this mock: complete()
// appends one JSON line per call to $PI_AI_MOCK_LOG and returns a canned
// reflection, so the reflection pipeline is assertable end-to-end without a
// model or subprocess.
const PI_AI_MOCK = join(SCRATCH, "mock-pi-ai.mjs");
writeFileSync(
  PI_AI_MOCK,
  [
    `import { appendFileSync } from "node:fs";`,
    `export function complete(model, context, options) {`,
    `  appendFileSync(process.env.PI_AI_MOCK_LOG, JSON.stringify({ model, context, options }) + "\\n");`,
    `  const text = JSON.stringify({ mistakes: ["m1", "m2"], fixes: ["f1", "f2"] });`,
    `  return Promise.resolve({ role: "assistant", content: [{ type: "text", text }] });`,
    `}`,
    `export function getModel() { return undefined; }`,
  ].join("\n"),
);
const PI_AI_LOG = join(SCRATCH, "pi-ai-calls.log");
writeFileSync(PI_AI_LOG, "");
process.env.PI_AI_MOCK_LOG = PI_AI_LOG;
const piAiCalls = () =>
  readFileSync(PI_AI_LOG, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { "@mariozechner/pi-ai": PI_AI_MOCK },
});

// ═══════════════════════════ agents-memo.ts ═════════════════════════════════
const memoMod = await jiti.import(join(REPO, "extensions", "agents-memo.ts"));
const mock = createMockPi();
memoMod.default(mock.pi);
const toolCall = (id, toolName, input) => mock.handlers["tool_call"].map((h) => h({ toolCallId: id, toolName, input }, mock.ctx)).filter((r) => r !== undefined);

// Seed a project core.md so before_agent_start / session_compact / the
// reflection pipeline have content to read and merge into. The handler slug
// derives from process.cwd() (repo root when run via `make test`), which is
// basename(REPO) since the git-remote execSync mock returns "".
const REPO_SLUG = basename(REPO);
const CORE_SEED = [
  "---",
  "type: project-core",
  `project: ${REPO_SLUG}`,
  "created: 2026-08-06",
  "updated: 2026-08-06",
  "---",
  "",
  `# Project Learnings — ${REPO_SLUG}`,
  "",
  "## High-value learnings",
  "- Keep edits small<!--score:1-->",
  "",
  "## Watch-outs",
  "- Avoid: guess without verifying<!--score:1-->",
  "",
].join("\n");
projectFiles.set(`wiki/projects/${REPO_SLUG}/core.md`, CORE_SEED);

// agent_end event with the conversation pi provides; the smoke test drives
// handlers directly, so messages must be supplied for the reflection path.
const agentEndEv = (msgs) => ({ messages: msgs ?? [{ role: "user", content: "session test", timestamp: 0 }] });

section("AC5 — MEMO_PLUGIN_PWD rewrite");
{
  const ev = { toolCallId: "t-var", toolName: "bash", input: { command: `echo \${MEMO_PLUGIN_PWD}/scripts/slug.sh "hello world"` } };
  const res = mock.handlers["tool_call"][0](ev, mock.ctx);
  assert(res === undefined, "rewrite allowed (no block)");
  assert(ev.input.command.includes(`${REPO}/scripts/slug.sh`), `braced var → plugin root (got: ${ev.input.command})`);
  const ev2 = { toolCallId: "t-var2", toolName: "bash", input: { command: "ls $MEMO_PLUGIN_PWD/skills" } };
  mock.handlers["tool_call"][0](ev2, mock.ctx);
  assert(ev2.input.command.includes(`${REPO}/skills`), "bare $MEMO_PLUGIN_PWD → plugin root");
}

section("AC6 — leading obsidian rewrite");
{
  const ev = { toolCallId: "t-obs", toolName: "bash", input: { command: "obsidian read path=wiki/hot.md" } };
  mock.handlers["tool_call"][0](ev, mock.ctx);
  assert(ev.input.command.startsWith(`"${REPO}/scripts/obsidian-cli.sh" read`), "leading obsidian → obsidian-cli.sh");
  const ev2 = { toolCallId: "t-obs2", toolName: "bash", input: { command: "  obsidian search query=term" } };
  mock.handlers["tool_call"][0](ev2, mock.ctx);
  assert(ev2.input.command.startsWith(`  "${REPO}/scripts/obsidian-cli.sh" search`), "indented obsidian → rewritten");
  // Heredoc bodies must NOT be rewritten: line-1-scoped rewrite parity with
  // the bash hook's `sed '1 s~...~'`. A prior /m-flag implementation
  // corrupted heredoc bodies.
  const ev3 = { toolCallId: "t-obs3", toolName: "bash", input: { command: "cat <<EOF\nobsidian read path=wiki/hot.md\nEOF" } };
  mock.handlers["tool_call"][0](ev3, mock.ctx);
  assert(ev3.input.command === "cat <<EOF\nobsidian read path=wiki/hot.md\nEOF", "heredoc body not rewritten");
}

section("AC7 — daily overwrite guard (#98)");
{
  // Fresh input objects per call — tool_call handlers mutate event.input.command,
  // so a shared object would leak rewritten state between assertions.
  const res = toolCall("t-daily2", "bash", { command: 'obsidian create path=daily/2026-08-06.md overwrite=true content="x"' })[0];
  assert(res?.block === true, "create overwrite=true on daily/*.md blocked");
  assert(/issue #98/.test(res?.reason ?? ""), "block reason mentions issue #98");
  const res2 = toolCall("t-daily4", "bash", { command: "obsidian create-or-append file=daily/2026-08-06.md content=x" })[0];
  assert(res2 === undefined, "create-or-append on daily allowed");
}

section("AC12 — vault I/O block + bypasses");
{
  const vp = (rel) => join(VAULT, rel);
  const blocked = (toolName, filePath) => {
    const input = toolName === "read" ? { file_path: filePath } : { path: filePath };
    const res = toolCall(`io-${toolName}-${calls.exec.length}`, toolName, input)[0];
    return res;
  };
  assert(blocked("read", vp("wiki/concepts/foo.md"))?.block === true, "read on vault path blocked");
  assert(blocked("write", vp("wiki/concepts/foo.md"))?.block === true, "write on vault path blocked");
  assert(blocked("edit", vp("wiki/concepts/foo.md"))?.block === true, "edit on vault path blocked");
  assert(blocked("read", vp("wiki/meta/../concepts/foo.md"))?.block === true, "normalized ../ path still blocked (realpath parity)");
  assert(blocked("read", vp(".raw/source.md")) === undefined, ".raw/** read bypass");
  assert(blocked("write", vp(".raw/.manifest.json")) === undefined, ".raw/.manifest.json write bypass");
  assert(blocked("write", vp("_attachments/img.png")) === undefined, "_attachments/** write bypass");
  assert(blocked("edit", vp("board.canvas")) === undefined, "*.canvas edit bypass");
  assert(blocked("write", vp(".raw/source.md"))?.block === true, ".raw/foo.md write blocked (read-only bypass)");
  assert(blocked("read", vp(".raw/.manifest.json")) === undefined, ".raw/.manifest.json read bypass");
  assert(blocked("write", vp("wiki/meta/lint-data-2026-08-06.json")) === undefined, "lint-data write bypass");
  assert(blocked("write", "README.md") === undefined, "outside-vault path pass-through");
  // Symlinked vault: a NEW-file write through the symlink must still be
  // blocked (realpath -ms parity). The previous plain-resolve() fallback
  // escaped containment for non-existent files under a symlinked vault.
  const linkVault = join(SCRATCH, "vault-link");
  try {
    symlinkSync(VAULT, linkVault, "dir");
    const sym = toolCall("io-symlink", "write", { path: join(linkVault, "wiki", "brand-new.md") })[0];
    assert(sym?.block === true, "new-file write via symlinked vault blocked (realpath -ms parity)");
  } catch {
    // filesystem without symlink support — skip
  }
}

const settled = () => Promise.all(mock.handlers["agent_settled"].map((h) => h({}, mock.ctx)));
// agent_end handlers are async (in-process reflection) — always await them so
// write assertions observe completed reflections.
const settledEnd = (ev) => Promise.all(mock.handlers["agent_end"].map((h) => h(ev, mock.ctx)));

section("AC16/17 — write-verb touched tracking");
{
  // Pin reflectUntouchedRuns=false for this section: these assertions verify
  // write-verb detection (untouched → no reflection). The untouched-run
  // reflection behavior is covered by its own PM2 section.
  const origPi = readFileSync(join(HOME, ".pi", "agent", "settings.json"), "utf-8");
  writeFileSync(join(HOME, ".pi", "agent", "settings.json"), JSON.stringify({
    agentsMemo: {
      vaultPath: VAULT,
      bootstrapReadHot: "always",
      bootstrapReadIndex: "on-demand",
      autoCommit: true,
      projectMemory: { reflectUntouchedRuns: false },
    },
  }));
  try {
  // Consume the per-run flag via agent_end (it resets the flag now, not
  // agent_settled) so this section starts from a clean slate.
  mock.setGitDirty(false);
  await settledEnd(agentEndEv());
  const appends = () => calls.exec.filter((c) => c.includes("create-or-append"));
  const before = appends().length;
  const readEv = { toolCallId: "t-r", toolName: "bash", input: { command: `obsidian read path=wiki/hot.md` } };
  mock.handlers["tool_call"][0](readEv, mock.ctx);
  await settledEnd(agentEndEv());
  assert(appends().length === before, "read-only session → no reflection append");
  const writeEv = { toolCallId: "t-w", toolName: "bash", input: { command: `obsidian create path=wiki/concepts/x.md content="hello"` } };
  mock.handlers["tool_call"][0](writeEv, mock.ctx);
  await settledEnd(agentEndEv());
  assert(appends().length === before + 1, "write verb → agent_end reflection appended");
  assert(/daily\/\d{4}-\d{2}-\d{2}\.md/.test(appends().at(-1) ?? ""), "reflection targets daily/YYYY-MM-DD.md");
  // eval write verb (parity with log-obsidian-calls.sh's auto-commit verbs).
  const evalEv = { toolCallId: "t-eval", toolName: "bash", input: { command: `obsidian eval code="1"` } };
  mock.handlers["tool_call"][0](evalEv, mock.ctx);
  await settledEnd(agentEndEv());
  assert(appends().length === before + 2, "eval verb → agent_end reflection appended");
  // non-write verb (read) after a pipe to a write word must NOT touch (verb is
  // extracted positionally, mirroring log-obsidian-calls.sh).
  const pipeEv = { toolCallId: "t-pipe", toolName: "bash", input: { command: `obsidian read path=wiki/hot.md | grep append` } };
  mock.handlers["tool_call"][0](pipeEv, mock.ctx);
  await settledEnd(agentEndEv());
  assert(appends().length === before + 2, "read | grep append → no reflection (positional verb extraction)");
  // compound already-routed command: the LAST write verb wins (parity with
  // log-obsidian-calls.sh's greedy `s/.*obsidian-cli\.sh[^[:space:]]* //`).
  const compoundEv = { toolCallId: "t-compound", toolName: "bash", input: { command: `"${REPO}/scripts/obsidian-cli.sh" read path=wiki/hot.md && "${REPO}/scripts/obsidian-cli.sh" append file=wiki/hot.md content="x"` } };
  mock.handlers["tool_call"][0](compoundEv, mock.ctx);
  await settledEnd(agentEndEv());
  assert(appends().length === before + 3, "compound read && append → reflection appended (last verb wins)");
  // env-prefixed raw command (FOO=bar obsidian ...): bash strips leading
  // KEY=val assignments before extracting the verb — the extension must too.
  const envEv = { toolCallId: "t-env", toolName: "bash", input: { command: `FOO=bar obsidian append file=wiki/hot.md content="x"` } };
  mock.handlers["tool_call"][0](envEv, mock.ctx);
  await settledEnd(agentEndEv());
  assert(appends().length === before + 4, "env-prefixed obsidian append → reflection appended");
  // trailing wrapper with no verb: bash's greedy regex backtracks to the
  // prior wrapper occurrence and still extracts the verb.
  const trailEv = { toolCallId: "t-trail", toolName: "bash", input: { command: `"${REPO}/scripts/obsidian-cli.sh" append file=wiki/hot.md content="x" && "${REPO}/scripts/obsidian-cli.sh"` } };
  mock.handlers["tool_call"][0](trailEv, mock.ctx);
  await settledEnd(agentEndEv());
  assert(appends().length === before + 5, "trailing wrapper backtracks to prior verb → reflection appended");
  } finally {
    writeFileSync(join(HOME, ".pi", "agent", "settings.json"), origPi);
  }
}

section("AC8-10 — before_agent_start injection");
{
  const results = mock.handlers["before_agent_start"].map((h) => h({}, mock.ctx)).filter((r) => r !== undefined);
  const types = results.map((r) => r.message.customType);
  assert(types.includes("agents-memo-init"), "INIT.md injected");
  const initMsg = results.find((r) => r.message.customType === "agents-memo-init")?.message;
  assert(initMsg?.display === false, "INIT message display:false");
  assert(initMsg?.content.includes(REPO), "INIT.md plugin-root placeholder substituted with resolved path");
  assert(!initMsg?.content.includes("${MEMO_PLUGIN_PWD}"), "INIT.md content free of ${MEMO_PLUGIN_PWD}");
  assert(!initMsg?.content.includes("${CLAUDE_PLUGIN_ROOT}"), "INIT.md content free of ${CLAUDE_PLUGIN_ROOT}");
  assert(initMsg?.content.includes(join(REPO, "skills", "vault-ops", "SKILL.md")), "INIT.md vault-ops path points at resolved plugin root");
  assert(types.includes("agents-memo-hot"), "hot.md injected when bootstrapReadHot=always");
  assert(results.find((r) => r.message.customType === "agents-memo-hot")?.message.content.includes("hot cache injected"), "hot.md content via obsidian-cli");
  assert(!types.includes("agents-memo-index"), "index.md NOT injected when bootstrapReadIndex=on-demand");
  // AC-PM: the memory digest is injected when projectMemory is enabled
  // (default), sourced from the project + global cores via the obsidian CLI.
  const digestMsg = results.find((r) => r.message.customType === "agents-memo-memory-digest")?.message;
  assert(!!digestMsg, "memory digest injected when projectMemory enabled (default)");
  assert(digestMsg?.display === false, "digest message display:false");
  assert(digestMsg?.content.startsWith("[agents-memo memory]"), "digest starts with the memory header");
  assert(digestMsg?.content.includes(`## Project learnings (${REPO_SLUG})`), "digest has project learnings section with slug");
  assert(digestMsg?.content.includes("- Keep edits small"), "digest carries top project learning from vault core.md");
  assert(digestMsg?.content.includes("Page candidates: 0"), "digest reports candidate count (no global core yet)");
  assert(!results.some((r) => r.message.customType === "agents-memo-project-core"), "phase-1 project-core customType replaced");
}

section("AC11 — session_compact re-injection");
{
  mock.handlers["session_compact"].forEach((h) => h({}, mock.ctx));
  const hotSends = mock.sent.filter((s) => s.msg.customType === "agents-memo-hot");
  assert(hotSends.length === 1, "hot.md re-injected via sendMessage");
  assert(hotSends[0]?.opts?.triggerTurn === false, "re-injection does not trigger a turn");
  assert(!mock.sent.some((s) => s.msg.customType === "agents-memo-index"), "index.md not re-injected (on-demand)");
  // AC-PM: the digest is re-injected from the slug cached at
  // before_agent_start (never process.cwd(), which may have changed).
  const digestSends = mock.sent.filter((s) => s.msg.customType === "agents-memo-memory-digest");
  assert(digestSends.length === 1, "memory digest re-injected on session_compact");
  assert(digestSends[0]?.opts?.triggerTurn === false, "digest re-injection does not trigger a turn");
  assert(digestSends[0]?.msg.content.includes(`## Project learnings (${REPO_SLUG})`), "digest re-injection has project learnings section");
}

section("AC13 — hot-cache 0-byte guard");
{
  writeFileSync(join(VAULT, "wiki", "hot.md"), "");
  const ev = { toolCallId: "t-hot", toolName: "bash", input: { command: 'obsidian create path=wiki/hot.md overwrite=true content=""' } };
  mock.handlers["tool_call"][0](ev, mock.ctx);
  mock.handlers["tool_execution_end"].forEach((h) => h({ toolCallId: "t-hot", toolName: "bash" }, mock.ctx));
  assert(calls.exec.some((c) => c.includes("checkout HEAD -- wiki/hot.md")), "0-byte hot.md → git restore from HEAD attempted");
  assert(mock.sent.some((s) => s.msg.customType === "agents-memo-warning"), "corruption warning message sent");
  assert(readFileSync(join(VAULT, "wiki", "hot.md"), "utf-8").trim().length > 0, "hot.md restored non-empty");
  const before = calls.exec.filter((c) => c.includes("checkout")).length;
  const ev2 = { toolCallId: "t-hot2", toolName: "bash", input: { command: "obsidian read path=wiki/hot.md" } };
  mock.handlers["tool_call"][0](ev2, mock.ctx);
  mock.handlers["tool_execution_end"].forEach((h) => h({ toolCallId: "t-hot2", toolName: "bash" }, mock.ctx));
  assert(calls.exec.filter((c) => c.includes("checkout")).length === before, "healthy hot.md → no restore");
}

section("AC14/15 — agent_settled auto-commit + notify");
{
  mock.setGitDirty(true);
  const writeEv = { toolCallId: "t-c1", toolName: "bash", input: { command: `obsidian append file=wiki/hot.md content="x"` } };
  mock.handlers["tool_call"][0](writeEv, mock.ctx);
  await settled();
  assert(mock.execs.some((e) => e[0] === "git" && e[1] === "-C" && e[3] === "status"), "git status checked");
  assert(mock.execs.some((e) => e[0] === "git" && e.includes("add")), "git add wiki/ .raw/");
  assert(mock.execs.some((e) => e[0] === "git" && e.includes("commit") && e.includes("auto: vault changes [agents-memo]")), "auto-commit with message");
  assert(mock.notifyCount() === 1, "WIKI_CHANGED notification shown");

  // Status gate is scoped to vault paths (parity with what git add stages):
  // Obsidian's own .obsidian/* churn must not keep the gate open.
  const statusCall = mock.execs.find((e) => e[0] === "git" && e[3] === "status");
  assert(statusCall?.includes("--") && statusCall.includes("wiki/") && statusCall.includes(".raw/"), "status gate scoped to wiki/ + .raw/ (pathspec)");

  // .obsidian/workspace.json churn alone → pathspec filters it → no
  // add/commit and no notify (the false-positive scenario from #186-era
  // regression that shipped the unconditional toast).
  mock.setGitDirty("obsidian");
  const beforeObs = mock.execs.length;
  const notifyBeforeObs = mock.notifyCount();
  await settled();
  assert(!mock.execs.slice(beforeObs).some((e) => e[0] === "git" && (e.includes("add") || e.includes("commit"))), ".obsidian churn alone → no git add/commit");
  assert(mock.notifyCount() === notifyBeforeObs, ".obsidian churn alone → no notification");

  // clean repo → status checked but no commit, no notify
  mock.setGitDirty(false);
  const writeEv2 = { toolCallId: "t-c2", toolName: "bash", input: { command: `obsidian append file=wiki/hot.md content="y"` } };
  mock.handlers["tool_call"][0](writeEv2, mock.ctx);
  const before = mock.execs.length;
  await settled();
  assert(!mock.execs.slice(before).some((e) => e[0] === "git" && (e.includes("add") || e.includes("commit"))), "clean repo → no git add/commit");
  assert(mock.notifyCount() === 1, "clean repo → no notification");

  // flag consumed by agent_end → subsequent settled() with no writes commits nothing
  await settledEnd({});
  const before2 = mock.execs.length;
  await settled();
  const postEnd = mock.execs.slice(before2);
  assert(!postEnd.some((e) => e[0] === "git" && (e.includes("add") || e.includes("commit"))), "untouched session → no git add/commit");

  // runtime ordering (verified in pi agent-session.js): agent_end fires before
  // agent_settled. Auto-commit must still fire when the vault is dirty, because
  // agent_settled decides from git status, not from the consumed flag.
  mock.setGitDirty(true);
  const writeEv3 = { toolCallId: "t-c3", toolName: "bash", input: { command: `obsidian append file=wiki/hot.md content="z"` } };
  mock.handlers["tool_call"][0](writeEv3, mock.ctx);
  await settledEnd({}); // agent_end consumes the flag first
  const before3 = mock.execs.length;
  await settled();
  assert(mock.execs.slice(before3).some((e) => e[0] === "git" && e.includes("commit")), "auto-commit still fires after agent_end (write → agent_end → agent_settled)");

  // commit exit 1 ("nothing to commit") → pi.exec resolves with {code: 1}
  // instead of throwing; the handler must not notify. Regression: false
  // 'auto-committed' toasts fired on every agent_settled while only non-wiki
  // changes existed, and the fix was previously lost in the pi migration
  // (a19f956) for lack of a commit-exit-1 test path.
  mock.setGitDirty(true);
  mock.setGitCommitCode(1);
  const writeEv4 = { toolCallId: "t-c4", toolName: "bash", input: { command: `obsidian append file=wiki/hot.md content="q"` } };
  mock.handlers["tool_call"][0](writeEv4, mock.ctx);
  const notifyBeforeFail = mock.notifyCount();
  await settled();
  assert(mock.execs.slice().some((e) => e[0] === "git" && e.includes("commit")), "commit attempted on wiki dirt");
  assert(mock.notifyCount() === notifyBeforeFail, "commit exit 1 → no notification");
  mock.setGitCommitCode(0);
}

section("AC17 — session_shutdown reflection");
{
  const before = calls.exec.filter((c) => c.includes("create-or-append")).length;
  const writeEv = { toolCallId: "t-s1", toolName: "bash", input: { command: `obsidian create path=notes/x.md content="z"` } };
  mock.handlers["tool_call"][0](writeEv, mock.ctx);
  mock.handlers["session_shutdown"].forEach((h) => h({}, mock.ctx));
  assert(calls.exec.filter((c) => c.includes("create-or-append")).length === before + 1, "session_shutdown appends summary reflection when vault touched");
}

section("AC17 — session_shutdown vault-cache invalidation");
{
  // A reused process starting in a different cwd must re-resolve the vault on
  // the next session. Regression: resetting vaultPathCached BEFORE the
  // handler's own getVaultPath() re-populated it, so the old vault stuck.
  // Drop the pi vaultPath so the CWD-wiki tier drives resolution here.
  const origPi = readFileSync(join(HOME, ".pi", "agent", "settings.json"), "utf-8");
  writeFileSync(join(HOME, ".pi", "agent", "settings.json"), JSON.stringify({
    agentsMemo: { bootstrapReadHot: "always" }, // no vaultPath
  }));
  const cwdA = process.cwd(); // repo root — no wiki/ here
  const cwdB = join(SCRATCH, "other-cwd");
  mkdirSync(join(cwdB, "wiki"), { recursive: true });
  mock.handlers["session_shutdown"].forEach((h) => h({}, mock.ctx)); // fire while still in cwdA
  process.chdir(cwdB);
  mock.ctx.cwd = cwdB; // simulate new session starting in different cwd
  try {
    const res = toolCall("t-reuse", "write", { path: join(cwdB, "wiki", "new.md") })[0];
    assert(res?.block === true, "post-shutdown cwd change re-resolves vault (new cwd wiki blocked)");
    const res2 = toolCall("t-reuse2", "write", { path: join(VAULT, "wiki", "new.md") })[0];
    assert(res2 === undefined, "old cached vault no longer used after cwd change");
  } finally {
    process.chdir(cwdA);
  }
  writeFileSync(join(HOME, ".pi", "agent", "settings.json"), origPi);
}

section("project-memory — slug derivation (git remote + sanitization)");
{
  gitUrlQueue = [
    "git@github.com:misiekhardcore/My_Repo.git\n",
    "https://github.com/owner/repo-name.git\n",
    "git@github.com:owner/repo.git\n",
  ];
  try {
    assert(memoMod.getProjectSlug("/tmp/cwd") === "my-repo", "git ssh URL → sanitized repo name (underscore → hyphen)");
    assert(memoMod.getProjectSlug("/tmp/cwd") === "repo-name", "git https URL → repo name");
    assert(memoMod.getProjectSlug("/tmp/cwd") === "repo", "git URL → bare repo name");
    assert(memoMod.getProjectSlug("/tmp/My Dir") === "my-dir", "no git → basename fallback (spaces → hyphens)");
    assert(memoMod.getProjectSlug("/tmp/My.Dir_1") === "my-dir-1", "basename dots/underscores → hyphens");
    assert(memoMod.getProjectSlug("/") === "unknown", "empty basename → unknown fallback");
  } finally {
    gitUrlQueue = [];
  }
}

section("project-memory — core.md pure functions");
{
  const { parseCoreFile, mergeReflection, renderCoreFile } = memoMod;
  const parsed = parseCoreFile(CORE_SEED);
  assert(parsed.learnings.length === 1 && parsed.learnings[0].text === "Keep edits small" && parsed.learnings[0].score === 1, "parse: learning bullet with score marker");
  assert(parsed.watchouts.length === 1 && parsed.watchouts[0].text === "guess without verifying" && parsed.watchouts[0].score === 1, "parse: watch-out 'Avoid:' prefix stripped");
  assert(!parsed.learnings[0].text.includes("<!--"), "parse: score marker not part of entry text");

  const reflection = { mistakes: ["guess without verifying", "new mistake"], fixes: ["Keep edits small", "write tests first"] };
  const merged = mergeReflection(parsed, reflection, 20);
  assert(merged.learnings.length === 2, "merge: existing learning + new fix");
  assert(merged.learnings.find((e) => e.text === "Keep edits small")?.score === 2, "merge: existing entry score incremented");
  assert(merged.learnings.find((e) => e.text === "write tests first")?.score === 1, "merge: new entry starts at score 1");
  assert(merged.watchouts.find((e) => e.text === "guess without verifying")?.score === 2, "merge: existing watch-out score incremented");
  assert(merged.watchouts.some((e) => e.text === "new mistake"), "merge: new watch-out added");

  const capped = mergeReflection({ learnings: [], watchouts: [] }, { mistakes: [], fixes: ["a", "b", "c", "d"] }, 3);
  assert(capped.learnings.length === 3, "merge: capped at maxItems");
  const dup = mergeReflection({ learnings: [{ text: "Keep Edits Small", score: 1 }], watchouts: [] }, { mistakes: [], fixes: ["Keep edits   small"] }, 5);
  assert(dup.learnings.length === 1 && dup.learnings[0].score === 2, "merge: dedup by normalized key (case + whitespace)");

  const rendered = renderCoreFile(REPO_SLUG, "2026-08-06", merged);
  assert(rendered.includes("type: project-core"), "render: frontmatter");
  assert(rendered.includes("## High-value learnings"), "render: learnings section");
  assert(rendered.includes("<!--score:2-->"), "render: score marker");
  assert(rendered.includes("- Avoid: guess without verifying"), "render: watch-outs prefixed with Avoid:");
  const reparsed = parseCoreFile(rendered);
  assert(reparsed.learnings.length === merged.learnings.length, "render → parse round-trip preserves learnings");
}

section("project-memory — agent_end reflection pipeline");
{
  // consume any residual touched flag
  await settledEnd({ messages: [] });
  const execBefore = calls.exec.length;
  const writeEv = { toolCallId: "t-pm1", toolName: "bash", input: { command: `obsidian create path=wiki/concepts/pm.md content="x"` } };
  mock.handlers["tool_call"][0](writeEv, mock.ctx);
  const conv = [
    { role: "user", content: "fix the merge bug", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "I changed the merge logic" }], timestamp: 2 },
  ];
  const reflectBefore = piAiCalls().length;
  const workingBefore = mock.workingMessages().length;
  await settledEnd({ messages: conv });
  const slice = calls.exec.slice(execBefore);

  // The reflection is an in-process complete() call (no pi subprocess).
  const reflCalls = piAiCalls().slice(reflectBefore);
  assert(reflCalls.length === 1, "agent_end performs exactly one complete() reflection call");
  const refl = reflCalls[0];
  assert(refl.model.provider === "deepseek" && refl.model.id === "deepseek-v4-flash", "reflection uses reflectModel provider/id");
  assert(refl.options?.maxTokens === 900, "reflection caps maxTokens");
  assert(refl.context?.messages?.[0]?.content?.[0]?.text.includes("<conversation>"), "reflection prompt embeds conversation");
  assert(refl.context?.messages?.[0]?.content?.[0]?.text.includes("Assistant: I changed the merge logic"), "reflection conversation serialized");
  assert(!slice.some((c) => c.includes("--mode") || c.includes("--no-session")), "no pi reflection subprocess spawned");

  // Working indicator parity with pi-self-learning: "learning" during the
  // pipeline, cleared afterwards.
  const working = mock.workingMessages().slice(workingBefore);
  assert(working[0] === "learning", "working indicator shown during learning");
  assert(working.at(-1) === null, "working indicator cleared after learning");

  const projAppend = slice.filter((c) => c.includes("create-or-append") && c.includes("wiki/projects/"));
  assert(projAppend.length === 1, "agent_end appends project daily entry");
  assert(/wiki\/projects\/[^\s]+\/daily\/\d{4}-\d{2}-\d{2}\.md/.test(projAppend[0] ?? ""), "project daily targets wiki/projects/<slug>/daily/YYYY-MM-DD.md");
  assert(slice.some((c) => c.includes("create") && c.includes("wiki/projects/") && c.includes("overwrite=true")), "core.md overwritten via obsidian create");

  const coreContent = projectFiles.get(`wiki/projects/${REPO_SLUG}/core.md`) ?? "";
  assert(coreContent.includes("## High-value learnings"), "core.md has learnings section");
  assert(coreContent.includes("f1") && coreContent.includes("f2"), "core.md contains reflection fixes");
  assert(coreContent.includes("- Avoid: m1"), "core.md watch-outs render with Avoid: prefix");
  // The seeded learning survives (not part of this reflection) and the
  // reflection entries were merged in - scores tracked via markers.
  assert(coreContent.includes("Keep edits small"), "core.md preserves pre-existing learnings");
  assert(/<!--score:\d+-->/.test(coreContent), "core.md entries carry score markers");
}

section("PM2 — withTimeout bounds the reflection model call (never hangs)");
{
  const { withTimeout } = memoMod;
  // A model call that never resolves must reject at the bound — the exact
  // failure mode that froze the session with the old spawnSync subprocess.
  const never = new Promise(() => {});
  let timedOut = false;
  const started = Date.now();
  try {
    await withTimeout(never, 50, "never-resolving test promise");
  } catch {
    timedOut = true;
  }
  assert(timedOut, "withTimeout rejects when the promise never resolves");
  assert(Date.now() - started < 2000, "withTimeout rejects at the bound, not later");

  // Resolving promises pass through and the timer is cleared.
  assert(await withTimeout(Promise.resolve("ok"), 50, "resolving test promise") === "ok", "withTimeout resolves the inner promise");

  // The controller is aborted on timeout so the underlying request is cancelled.
  const controller = new AbortController();
  let aborted = false;
  controller.signal.addEventListener("abort", () => { aborted = true; });
  try {
    await withTimeout(never, 20, "abort test", controller);
  } catch {
    // expected
  }
  assert(aborted, "withTimeout aborts the controller on timeout");
}

section("PM2 — working indicator clears when reflection yields nothing");
{
  // No resolvable model → runReflection returns null → the indicator must
  // still be cleared (finally), never left stale.
  const origRegistry = mock.ctx.modelRegistry;
  mock.ctx.modelRegistry = { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false, error: "none" }) };
  const workingBefore = mock.workingMessages().length;
  try {
    await settledEnd(agentEndEv());
    const working = mock.workingMessages().slice(workingBefore);
    assert(working[0] === "learning", "indicator shown before reflection attempt");
    assert(working.at(-1) === null, "indicator cleared on null reflection (finally)");
  } finally {
    mock.ctx.modelRegistry = origRegistry;
  }
}

section("project-memory — enabled=false falls back to legacy daily marker");
{
  const origPi = readFileSync(join(HOME, ".pi", "agent", "settings.json"), "utf-8");
  writeFileSync(join(HOME, ".pi", "agent", "settings.json"), JSON.stringify({
    agentsMemo: { vaultPath: VAULT, projectMemory: { enabled: false } },
  }));
  try {
    await settledEnd({ messages: [] }); // consume residual flag
    const execBefore = calls.exec.length;
    const reflectBefore = piAiCalls().length;
    const workingBefore = mock.workingMessages().length;
    const writeEv = { toolCallId: "t-pm2", toolName: "bash", input: { command: `obsidian create path=wiki/concepts/legacy.md content="x"` } };
    mock.handlers["tool_call"][0](writeEv, mock.ctx);
    await settledEnd(agentEndEv());
    const slice = calls.exec.slice(execBefore);
    const appends = slice.filter((c) => c.includes("create-or-append"));
    assert(appends.length === 1, "enabled=false → legacy global daily append");
    assert(/daily\/\d{4}-\d{2}-\d{2}\.md/.test(appends[0] ?? ""), "legacy append targets global daily/YYYY-MM-DD.md");
    assert(!(appends[0] ?? "").includes("wiki/projects/"), "legacy append is NOT project-scoped");
    assert(piAiCalls().length === reflectBefore, "enabled=false → no reflection complete() call");
    assert(!mock.workingMessages().slice(workingBefore).includes("learning"), "enabled=false → no working indicator");
  } finally {
    writeFileSync(join(HOME, ".pi", "agent", "settings.json"), origPi);
  }
}

section("PM2-config — readPiSettings nested-block merge + defaults");
{
  const globalSettings = join(HOME, ".pi", "agent", "settings.json");
  const origGlobal = readFileSync(globalSettings, "utf-8");
  const projSettingsDir = join(SCRATCH, "cfg-cwd");
  mkdirSync(join(projSettingsDir, ".pi"), { recursive: true });
  const projSettings = join(projSettingsDir, ".pi", "settings.json");
  const cwdBefore = process.cwd();

  // Absent config → phase-2 defaults applied, phase-1 keys unaffected.
  writeFileSync(globalSettings, JSON.stringify({ agentsMemo: { vaultPath: VAULT } }));
  writeFileSync(projSettings, JSON.stringify({}));
  process.chdir(projSettingsDir);
  try {
    let cfg = memoMod.readPiSettings();
    assert(cfg.vaultPath === VAULT, "top-level key resolved alongside new blocks");
    assert(cfg.projectMemory.enabled === true, "default projectMemory.enabled=true (phase 1 intact)");
    assert(cfg.projectMemory.globalEnabled === true, "default globalEnabled=true");
    assert(cfg.projectMemory.maxGlobalItems === 20, "default maxGlobalItems=20");
    assert(cfg.projectMemory.promotionThreshold === 2, "default promotionThreshold=2");
    assert(cfg.projectMemory.reflectUntouchedRuns === true, "default reflectUntouchedRuns=true");
    assert(cfg.memoryInjection.sessionStart === true, "default memoryInjection.sessionStart=true");
    assert(cfg.memoryInjection.reInjectOnCompact === true, "default memoryInjection.reInjectOnCompact=true");
    assert(cfg.memoryInjection.digestBudgetChars === 800, "default digestBudgetChars=800");
    assert(cfg.memoryInjection.projectCoreTop === 5, "default projectCoreTop=5");
    assert(cfg.memoryInjection.globalCoreTop === 5, "default globalCoreTop=5");
    assert(cfg.pageCandidacy.threshold === 3, "default pageCandidacy.threshold=3");

    // Per-key first-wins across tiers: the global file wins every key it
    // defines; the project file only fills keys the global file leaves
    // undefined.
    writeFileSync(globalSettings, JSON.stringify({ agentsMemo: { projectMemory: { globalEnabled: false, promotionThreshold: 3 } } }));
    writeFileSync(projSettings, JSON.stringify({ agentsMemo: { projectMemory: { globalEnabled: true, maxGlobalItems: 7, reflectUntouchedRuns: false } } }));
    cfg = memoMod.readPiSettings();
    assert(cfg.projectMemory.globalEnabled === false, "global tier wins globalEnabled");
    assert(cfg.projectMemory.promotionThreshold === 3, "global tier wins promotionThreshold");
    assert(cfg.projectMemory.maxGlobalItems === 7, "project tier fills undefined maxGlobalItems");
    assert(cfg.projectMemory.reflectUntouchedRuns === false, "project tier fills undefined reflectUntouchedRuns");
    assert(cfg.projectMemory.enabled === true, "unspecified key falls to default");

    // memoryInjection + pageCandidacy: same per-key first-wins + defaults.
    writeFileSync(globalSettings, JSON.stringify({ agentsMemo: { memoryInjection: { digestBudgetChars: 1200 } } }));
    writeFileSync(projSettings, JSON.stringify({ agentsMemo: { memoryInjection: { sessionStart: false, digestBudgetChars: 500 }, pageCandidacy: { threshold: 5 } } }));
    cfg = memoMod.readPiSettings();
    assert(cfg.memoryInjection.digestBudgetChars === 1200, "global tier wins digestBudgetChars");
    assert(cfg.memoryInjection.sessionStart === false, "project tier fills sessionStart");
    assert(cfg.memoryInjection.reInjectOnCompact === true, "unset memoryInjection key → default");
    assert(cfg.pageCandidacy.threshold === 5, "pageCandidacy merged from project tier");

    // Malformed values are type-gated → defaults, never garbage.
    writeFileSync(globalSettings, JSON.stringify({ agentsMemo: { projectMemory: { maxGlobalItems: "many" }, pageCandidacy: { threshold: "high" } } }));
    writeFileSync(projSettings, JSON.stringify({}));
    cfg = memoMod.readPiSettings();
    assert(cfg.projectMemory.maxGlobalItems === 20, "malformed maxGlobalItems rejected → default");
    assert(cfg.pageCandidacy.threshold === 3, "malformed threshold rejected → default");

    // Numeric holes: JSON.parse accepts 1e999 (→ Infinity) and negatives
    // pass typeof number — counts/budgets must be finite integers >= 0 or
    // the digest silently degrades (NaN/±Infinity budgets, negative caps).
    writeFileSync(globalSettings, '{ "agentsMemo": { "memoryInjection": { "digestBudgetChars": 1e999, "projectCoreTop": -3, "globalCoreTop": 2.5 } } }');
    writeFileSync(projSettings, JSON.stringify({}));
    cfg = memoMod.readPiSettings();
    assert(cfg.memoryInjection.digestBudgetChars === 800, "Infinity digestBudgetChars rejected → default");
    assert(cfg.memoryInjection.projectCoreTop === 5, "negative projectCoreTop rejected → default");
    assert(cfg.memoryInjection.globalCoreTop === 5, "fractional globalCoreTop rejected too (integer counts only)");
    writeFileSync(globalSettings, JSON.stringify({ agentsMemo: { projectMemory: { promotionThreshold: -1 }, pageCandidacy: { threshold: 0 } } }));
    writeFileSync(projSettings, JSON.stringify({}));
    cfg = memoMod.readPiSettings();
    assert(cfg.projectMemory.promotionThreshold === 2, "negative promotionThreshold rejected → default");
    assert(cfg.pageCandidacy.threshold === 0, "threshold 0 is a valid integer (>= 0)");
  } finally {
    process.chdir(cwdBefore);
    writeFileSync(globalSettings, origGlobal);
  }
}

section("PM2-reflection — global-bucket prompt + parser");
{
  const prompt = memoMod.buildReflectionSystemPrompt(5);
  assert(prompt.includes('"global"'), "prompt asks for global bucket");
  assert(prompt.includes("design patterns"), "prompt lists design patterns");
  assert(prompt.includes("non-trivial bug fixes"), "prompt lists non-trivial bug fixes");
  assert(prompt.includes("architecture decisions"), "prompt lists architecture decisions");
  assert(prompt.includes("no project"), "prompt demands generic wording (no project identifiers)");
  assert(prompt.includes("max 5"), "prompt keeps max-items constraint");

  const p = memoMod.parseReflectionJson;
  const three = p('{"mistakes":["m"],"fixes":["f"],"global":["g"]}');
  assert(three?.mistakes.length === 1 && three?.fixes.length === 1 && three?.global?.length === 1, "parser extracts all three buckets");
  const globalOnly = p('{"global":["reusable pattern"]}');
  assert(!!globalOnly && globalOnly.mistakes.length === 0 && globalOnly.fixes.length === 0 && globalOnly.global?.[0] === "reusable pattern", "global-only response valid");
  assert(p('{"mistakes":["m"]}') !== null, "mistakes-only response still valid");
  assert(p('{"fixes":["f"]}') !== null, "fixes-only response still valid");
  assert(p('{"mistakes":[],"fixes":[],"global":[]}') === null, "all-empty buckets → invalid");
  assert(p("not json") === null, "garbage → null");
  const fenced = p('```json\n{"global":["g"],"mistakes":["m"],"fixes":["f"]}\n```');
  assert(fenced?.global?.[0] === "g", "fenced JSON with global bucket parses");
  const mixed = p('{"global":["g", 42, null]}');
  assert(mixed?.global?.length === 1 && mixed.global[0] === "g", "non-string global entries filtered");
}

section("PM2-globalcore — global-core render/merge/update engine");
{
  const { parseCoreFile, renderGlobalCore, updateGlobalCore } = memoMod;

  // Round-trip: rendered global core parses back to the same entries; score
  // and candidate markers are render-side concerns, never part of the text.
  const learnings = [
    { text: "Prefer small, reviewable diffs", score: 3 },
    { text: "Trace config keys to call sites before claiming dead", score: 1 },
  ];
  const rendered = renderGlobalCore("2026-08-01", "2026-08-07", learnings, 3);
  assert(rendered.startsWith("---\ntype: global-core"), "render: global-core frontmatter");
  assert(rendered.includes("created: 2026-08-01"), "render: created date passed through");
  assert(rendered.includes("updated: 2026-08-07"), "render: updated date passed through");
  assert(rendered.includes("# Global Learnings"), "render: H1 Global Learnings");
  assert(rendered.includes("## High-value learnings"), "render: single learnings section");
  assert(!rendered.includes("## Watch-outs"), "render: no watch-outs section in global core");
  assert(rendered.includes("Prefer small, reviewable diffs<!--score:3--><!--candidate-->"), "render: candidate marker when score >= threshold");
  const traceLine = rendered.split("\n").find((l) => l.includes("Trace config"));
  assert(!!traceLine && !traceLine.includes("<!--candidate-->"), "render: no candidate marker below threshold");

  const reparsed = parseCoreFile(rendered);
  assert(reparsed.learnings.length === 2, "round-trip: entry count preserved");
  assert(reparsed.learnings[0].text === "Prefer small, reviewable diffs" && reparsed.learnings[0].score === 3, "round-trip: text + score preserved");
  assert(reparsed.learnings[1].text === "Trace config keys to call sites before claiming dead" && reparsed.learnings[1].score === 1, "round-trip: second entry preserved");
  assert(reparsed.watchouts.length === 0, "round-trip: no watchouts from global core");
  assert(!reparsed.learnings.some((e) => e.text.includes("<!--")), "round-trip: score + candidate markers stripped from text");

  // updateGlobalCore end-to-end: seed a promoted pointer bullet, then merge a
  // raw reflection item that duplicates it modulo the [[wikilink]] and case /
  // whitespace variance - score must increment through the link.
  projectFiles.set("wiki/global-core.md", [
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
  ].join("\n"));
  updateGlobalCore(VAULT, "2026-08-07", { mistakes: [], fixes: [], global: ["Prefer   small, reviewable diffs"] }, 5, 3);
  const mergedCore = projectFiles.get("wiki/global-core.md") ?? "";
  assert(mergedCore.includes("- Prefer small, reviewable diffs [[review-process]]<!--score:3--><!--candidate-->"), "update: wikilink bullet dedups against raw text (score 2→3), pointer kept, candidate rendered");
  assert(mergedCore.includes("[[review-process]]"), "update: wikilink pointer preserved in rendered bullet");
  assert(mergedCore.includes("<!--candidate-->"), "update: score 3 at threshold renders candidate marker");
  const mergedParsed = parseCoreFile(mergedCore);
  assert(mergedParsed.learnings.length === 1 && mergedParsed.learnings[0].score === 3, "update: normalizeKey strips the wikilink for dedup (single entry, score 3)");

  // Cap: maxGlobalItems drops the lowest-scored entries, keeps the top.
  updateGlobalCore(VAULT, "2026-08-07", { mistakes: [], fixes: [], global: ["a", "b", "c", "d"] }, 2, 3);
  const cappedParsed = parseCoreFile(projectFiles.get("wiki/global-core.md") ?? "");
  assert(cappedParsed.learnings.length === 2, "update: capped at maxGlobalItems");
  assert(cappedParsed.learnings[0].text === "Prefer small, reviewable diffs [[review-process]]" && cappedParsed.learnings[0].score === 3, "update: cap keeps highest-scored entry first");
  assert(cappedParsed.learnings[1].score === 1, "update: cap drops lowest scores (stable order)");

  // Fresh start: missing file = empty core; only the global bucket lands in
  // wiki/global-core.md (mistakes/fixes stay in the project core).
  projectFiles.delete("wiki/global-core.md");
  updateGlobalCore(VAULT, "2026-08-07", { mistakes: ["m"], fixes: ["f"], global: ["Reusable pattern"] }, 20, 3);
  const freshCore = projectFiles.get("wiki/global-core.md") ?? "";
  assert(freshCore.includes("- Reusable pattern<!--score:1-->"), "update: missing file starts from empty core");
  assert(!freshCore.includes("- m") && !freshCore.includes("- f"), "update: only the global bucket lands in global core");
  assert(!freshCore.includes("<!--candidate-->"), "update: score 1 below threshold renders no candidate marker");

  // Empty global bucket (reflection without global items): merge is a no-op
  // over the existing entries.
  updateGlobalCore(VAULT, "2026-08-07", { mistakes: ["m"], fixes: ["f"], global: [] }, 20, 3);
  const noopCore = projectFiles.get("wiki/global-core.md") ?? "";
  assert(noopCore.includes("- Reusable pattern<!--score:1-->") && !noopCore.includes("- m"), "update: empty global bucket leaves entries untouched");
  projectFiles.delete("wiki/global-core.md");

  // Created-date preservation (regression): a merge must keep the ORIGINAL
  // created date from the existing file and only refresh updated — stamping
  // today's date over created loses the store's birth record.
  projectFiles.set("wiki/global-core.md", [
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
  ].join("\n"));
  updateGlobalCore(VAULT, "2026-08-07", { mistakes: [], fixes: [], global: ["New entry"] }, 20, 3);
  const dated = projectFiles.get("wiki/global-core.md") ?? "";
  assert(dated.includes("created: 2026-08-01"), "update: merge keeps the original created date");
  assert(dated.includes("updated: 2026-08-07"), "update: merge refreshes only the updated date");
  assert(dated.includes("- New entry<!--score:1-->"), "update: created-date handling leaves content untouched");
  // Fresh start (missing file): created = today.
  projectFiles.delete("wiki/global-core.md");
  updateGlobalCore(VAULT, "2026-08-07", { mistakes: [], fixes: [], global: ["Brand new"] }, 20, 3);
  const freshDated = projectFiles.get("wiki/global-core.md") ?? "";
  assert(freshDated.includes("created: 2026-08-07") && freshDated.includes("updated: 2026-08-07"), "update: missing file → created = today");
  projectFiles.delete("wiki/global-core.md");
}

section("PM2 — shell-metacharacter escaping (regression)");
{
  // Reflection-generated text flows through escapeShellContent into a
  // double-quoted shell argument. $ and backticks are live in double-quoted
  // bash args (command substitution) — a bullet like "use $(echo PWNED)"
  // must reach the vault as literal text, not execute (verified: unescaped
  // $(echo PWNED) executes — the shared helper is the single fix point).
  const { updateGlobalCore } = memoMod;
  projectFiles.delete("wiki/global-core.md");
  const before = calls.exec.length;
  updateGlobalCore(VAULT, "2026-08-07", { mistakes: [], fixes: [], global: ["use $(echo PWNED) and `whoami`"] }, 5, 3);
  const cmd = calls.exec.slice(before).find((c) => c.includes("wiki/global-core.md") && c.includes("overwrite=true")) ?? "";
  assert(cmd.includes("\\$(echo PWNED)"), "$ escaped in the shell argument");
  assert(!/(^|[^\\])\$\(/.test(cmd), "no unescaped $() command substitution reaches the shell");
  assert(cmd.includes("\\`whoami\\`"), "backtick escaped in the shell argument");
  assert(!/(^|[^\\])`/.test(cmd), "no unescaped backtick substitution reaches the shell");
  projectFiles.delete("wiki/global-core.md");
}

section("PM2-globalcore — read-failure guard (no clobber)");
{
  const { updateGlobalCore, execObsidianReadSafe } = memoMod;
  projectFiles.delete("wiki/global-core.md");

  // Missing file → ok with empty content (cold-start condition).
  const missing = execObsidianReadSafe(VAULT, "wiki/global-core.md");
  assert(missing.ok === true && missing.content === "", "missing file → ok:true with empty content");

  // The wrapper's "File ... not found" stdout shape classifies as missing,
  // not as a read failure.
  failReads.set("wiki/global-core.md", 'Error: File "wiki/global-core.md" not found.');
  const notFound = execObsidianReadSafe(VAULT, "wiki/global-core.md");
  assert(notFound.ok === true && notFound.content === "", "CLI 'File not found' error → ok:true with empty content");
  failReads.delete("wiki/global-core.md");

  // Generic read failure → not-ok; updateGlobalCore must skip the write so a
  // transient CLI failure cannot clobber the accumulated corpus.
  failReads.set("wiki/global-core.md", "Error: something broke");
  updateGlobalCore(VAULT, "2026-08-07", { mistakes: [], fixes: [], global: ["should not land"] }, 20, 3);
  assert(projectFiles.get("wiki/global-core.md") === undefined, "read failure → global core NOT written (no clobber)");
  failReads.delete("wiki/global-core.md");

  // Failure cleared → a still-missing file proceeds with an empty core.
  updateGlobalCore(VAULT, "2026-08-07", { mistakes: [], fixes: [], global: ["Fresh start"] }, 20, 3);
  const fresh = projectFiles.get("wiki/global-core.md") ?? "";
  assert(fresh.includes("- Fresh start<!--score:1-->"), "missing file → update proceeds with empty core");
  projectFiles.delete("wiki/global-core.md");

  // updateProjectCore gets the same guard: a transient read failure must not
  // clobber the accumulated project corpus either (missing file still
  // proceeds from an empty core — phase-1 happy path parity).
  const { updateProjectCore } = memoMod;
  const projRel = `wiki/projects/${REPO_SLUG}/core.md`;
  const projSeed = [
    "---", "type: project-core", `project: ${REPO_SLUG}`, "created: 2026-08-06", "updated: 2026-08-06", "---", "",
    "## High-value learnings",
    "- Keep edits small<!--score:2-->",
    "",
  ].join("\n");
  projectFiles.set(projRel, projSeed);
  failReads.set(projRel, "Error: something broke");
  updateProjectCore(VAULT, REPO_SLUG, "2026-08-07", { mistakes: [], fixes: ["should not land"], global: [] }, 20);
  assert(projectFiles.get(projRel) === projSeed, "project read failure → project core NOT written (no clobber)");
  failReads.delete(projRel);
  projectFiles.delete(projRel);
  updateProjectCore(VAULT, REPO_SLUG, "2026-08-07", { mistakes: [], fixes: ["Fresh fix"], global: [] }, 20);
  const freshProj = projectFiles.get(projRel) ?? "";
  assert(freshProj.includes("- Fresh fix<!--score:1-->"), "missing project core → update proceeds with empty core");
  projectFiles.delete(projRel);
}

section("PM2-digest — buildDigest (top-N, budget, candidates)");
{
  const { buildDigest } = memoMod;
  const cfg = memoMod.readPiSettings(); // defaults: tops 5, budget 800, threshold 3
  const seedProject = [
    "---", "type: project-core", `project: ${REPO_SLUG}`, "created: 2026-08-07", "updated: 2026-08-07", "---", "",
    `# Project Learnings — ${REPO_SLUG}`, "",
    "## High-value learnings",
    "- Keep edits small<!--score:4-->",
    "- Verify before claiming<!--score:2-->",
    "- Trace config keys<!--score:1-->",
    "",
    "## Watch-outs",
    "- Avoid: guess without verifying<!--score:1-->",
    "",
  ].join("\n");
  const seedGlobal = [
    "---", "type: global-core", "created: 2026-08-07", "updated: 2026-08-07", "---", "",
    "# Global Learnings", "",
    "## High-value learnings",
    "- Prefer small diffs<!--score:5-->",
    "- Reusable pattern<!--score:3-->",
    "- Low score item<!--score:1-->",
    "",
  ].join("\n");
  projectFiles.set(`wiki/projects/${REPO_SLUG}/core.md`, seedProject);
  projectFiles.set("wiki/global-core.md", seedGlobal);

  const digest = buildDigest(VAULT, REPO_SLUG, cfg);
  assert(!!digest, "digest built when both cores have content");
  assert(digest.startsWith(`[agents-memo memory]\n## Project learnings (${REPO_SLUG})`), "digest header + project section with slug");
  assert(digest.includes("## Global learnings"), "digest has global section");
  assert(digest.includes("- Keep edits small"), "digest includes top project learning");
  assert(digest.includes("- Prefer small diffs"), "digest includes top global learning");
  assert(!digest.includes("Avoid: guess"), "watch-outs never appear in the digest");
  assert(digest.includes("Full memory on demand: /query or obsidian search."), "pointer line present");

  // Top-N caps apply by score (stable): smaller tops drop the lowest bullets.
  const smallCfg = { ...cfg, memoryInjection: { ...cfg.memoryInjection, projectCoreTop: 2, globalCoreTop: 1 } };
  const small = buildDigest(VAULT, REPO_SLUG, smallCfg);
  assert(small.includes("- Keep edits small") && small.includes("- Verify before claiming") && !small.includes("- Trace config keys"), "projectCoreTop caps project bullets by score");
  assert(small.includes("- Prefer small diffs") && !small.includes("- Reusable pattern"), "globalCoreTop caps global bullets by score");
  // Candidate count reflects the whole store, not the truncated digest view:
  // scores 5 and 3 are at/above threshold 3 even though only 1 global bullet
  // is shown with globalCoreTop=1.
  assert(small.includes("Page candidates: 2"), "candidate count = all global learnings at/above threshold");

  // Budget truncation at bullet boundaries: fits the top bullet only.
  const pointer = digest.slice(digest.indexOf("\n\nPage candidates:"));
  const header = `[agents-memo memory]\n## Project learnings (${REPO_SLUG})\n## Global learnings`;
  const budgetOne = header.length + "- Keep edits small".length + pointer.length + 1;
  const one = buildDigest(VAULT, REPO_SLUG, { ...cfg, memoryInjection: { ...cfg.memoryInjection, digestBudgetChars: budgetOne } });
  assert(!!one && one.length <= budgetOne, "truncated digest respects budget");
  assert(one.includes("- Keep edits small"), "budget fits the top project bullet");
  assert(!one.includes("- Verify before claiming"), "second bullet dropped at boundary (no partial bullets)");
  assert(one.includes("Full memory on demand"), "pointer kept after truncation");

  // Budget below the fixed header + pointer → all bullets dropped, pointer kept.
  const noBullets = buildDigest(VAULT, REPO_SLUG, { ...cfg, memoryInjection: { ...cfg.memoryInjection, digestBudgetChars: 1 } });
  assert(!!noBullets && !noBullets.includes("- Keep edits small"), "budget below headers → all bullets dropped");
  assert(noBullets.includes("[agents-memo memory]"), "header kept even when over budget");
  assert(noBullets.includes("Full memory on demand: /query or obsidian search."), "pointer line kept even when over budget");

  // Empty/missing cores → null (no injection at all).
  projectFiles.delete("wiki/global-core.md");
  projectFiles.delete(`wiki/projects/${REPO_SLUG}/core.md`);
  assert(buildDigest(VAULT, REPO_SLUG, cfg) === null, "both cores missing → null");
  projectFiles.set(`wiki/projects/${REPO_SLUG}/core.md`, "# Project Learnings\n\n## High-value learnings\n- (none yet)\n");
  projectFiles.set("wiki/global-core.md", "# Global Learnings\n\n## High-value learnings\n- (none yet)\n");
  assert(buildDigest(VAULT, REPO_SLUG, cfg) === null, "both cores empty → null");

  // Read failures are tolerated per-side (digest is read-only): a failing
  // global read still yields the project side; both failing → null.
  projectFiles.set(`wiki/projects/${REPO_SLUG}/core.md`, seedProject);
  projectFiles.set("wiki/global-core.md", seedGlobal);
  failReads.set("wiki/global-core.md", "Error: CLI exploded");
  const oneSided = buildDigest(VAULT, REPO_SLUG, cfg);
  assert(!!oneSided && oneSided.includes("- Keep edits small") && !oneSided.includes("- Prefer small diffs"), "global read failure → project side still injected");
  failReads.set(`wiki/projects/${REPO_SLUG}/core.md`, "Error: CLI exploded");
  assert(buildDigest(VAULT, REPO_SLUG, cfg) === null, "both reads failed → null");
  failReads.clear();
  projectFiles.delete("wiki/global-core.md");
}

section("PM2-agent_end — reflectUntouchedRuns gate + global write");
{
  const origPi = readFileSync(join(HOME, ".pi", "agent", "settings.json"), "utf-8");
  // Consume any residual touched flag (messages empty → no reflection).
  await settledEnd({ messages: [] });
  try {
    // Default (reflectUntouchedRuns=true): an untouched run still reflects —
    // daily entry + project core + global core all written (empty-bucket
    // no-ops where there is nothing to merge).
    projectFiles.delete("wiki/global-core.md");
    const execBefore = calls.exec.length;
    const reflectBefore = piAiCalls().length;
    await settledEnd(agentEndEv());
    const slice = calls.exec.slice(execBefore);
    assert(piAiCalls().length === reflectBefore + 1, "untouched run reflects when reflectUntouchedRuns=true (default)");
    assert(slice.some((c) => c.includes("create-or-append") && c.includes("wiki/projects/")), "untouched run still writes the project daily entry");
    assert(slice.some((c) => c.includes("create") && c.includes("wiki/global-core.md") && c.includes("overwrite=true")), "untouched run writes global core (empty-bucket no-op)");

    // reflectUntouchedRuns=false → untouched run skips everything.
    writeFileSync(join(HOME, ".pi", "agent", "settings.json"), JSON.stringify({
      agentsMemo: { vaultPath: VAULT, projectMemory: { reflectUntouchedRuns: false } },
    }));
    const execBefore2 = calls.exec.length;
    await settledEnd(agentEndEv());
    const slice2 = calls.exec.slice(execBefore2);
    assert(slice2.length === 0, "reflectUntouchedRuns=false → untouched run reflects nothing");

    // globalEnabled=false → project pipeline still runs, global write skipped.
    writeFileSync(join(HOME, ".pi", "agent", "settings.json"), JSON.stringify({
      agentsMemo: { vaultPath: VAULT, projectMemory: { globalEnabled: false } },
    }));
    const writeEv = { toolCallId: "t-pm2g", toolName: "bash", input: { command: `obsidian create path=wiki/concepts/pm2.md content="x"` } };
    mock.handlers["tool_call"][0](writeEv, mock.ctx);
    const execBefore3 = calls.exec.length;
    const reflectBefore3 = piAiCalls().length;
    await settledEnd(agentEndEv());
    const slice3 = calls.exec.slice(execBefore3);
    assert(piAiCalls().length === reflectBefore3 + 1, "globalEnabled=false → reflection still runs");
    assert(slice3.some((c) => c.includes("create") && c.includes("wiki/projects/") && c.includes("overwrite=true")), "globalEnabled=false → project core still written");
    assert(!slice3.some((c) => c.includes("create") && c.includes("wiki/global-core.md") && c.includes("overwrite=true")), "globalEnabled=false → global core NOT written");
  } finally {
    writeFileSync(join(HOME, ".pi", "agent", "settings.json"), origPi);
  }
}

section("PM2-digest — injection flags (sessionStart / reInjectOnCompact)");
{
  const origPi = readFileSync(join(HOME, ".pi", "agent", "settings.json"), "utf-8");
  // Fresh module = fresh session (bootstrap latch reset), so the sessionStart
  // flag is observable at before_agent_start on the FIRST prompt.
  const memo2 = await jiti.import(join(REPO, "extensions", "agents-memo.ts"));
  const mock2 = createMockPi();
  memo2.default(mock2.pi);
  const fireStart = () => mock2.handlers["before_agent_start"].map((h) => h({}, mock2.ctx)).filter((r) => r !== undefined);
  try {
    writeFileSync(join(HOME, ".pi", "agent", "settings.json"), JSON.stringify({
      agentsMemo: { vaultPath: VAULT, bootstrapReadHot: "always", memoryInjection: { sessionStart: false } },
    }));
    const results = fireStart();
    assert(!results.some((r) => r.message.customType === "agents-memo-memory-digest"), "sessionStart=false → no digest on first prompt");
    assert(results.some((r) => r.message.customType === "agents-memo-init"), "sessionStart=false → INIT injection unaffected");

    writeFileSync(join(HOME, ".pi", "agent", "settings.json"), JSON.stringify({
      agentsMemo: { vaultPath: VAULT, memoryInjection: { reInjectOnCompact: false } },
    }));
    mock2.handlers["session_compact"].forEach((h) => h({}, mock2.ctx));
    assert(!mock2.sent.some((s) => s.msg.customType === "agents-memo-memory-digest"), "reInjectOnCompact=false → no digest on compact");

    // Decoupled slug cache: sessionStart=false still caches the slug at
    // before_agent_start, so reInjectOnCompact=true alone re-injects the
    // digest at compaction (no session-start digest was ever shown).
    mock2.sent.length = 0;
    writeFileSync(join(HOME, ".pi", "agent", "settings.json"), JSON.stringify({
      agentsMemo: { vaultPath: VAULT, memoryInjection: { sessionStart: false, reInjectOnCompact: true } },
    }));
    fireStart();
    assert(!mock2.sent.some((s) => s.msg.customType === "agents-memo-memory-digest"), "sessionStart=false → still no digest at start");
    mock2.handlers["session_compact"].forEach((h) => h({}, mock2.ctx));
    assert(mock2.sent.some((s) => s.msg.customType === "agents-memo-memory-digest"), "sessionStart=false + reInjectOnCompact=true → digest re-injected at compact from cached slug");
  } finally {
    writeFileSync(join(HOME, ".pi", "agent", "settings.json"), origPi);
  }
}

section("PM2-sweep — cross-project promotion");
{
  const { findCrossProjectEntries, sweepPromoteGlobal } = memoMod;

  // Pure counting helper: normalized dedup across projects, threshold gate.
  const projects = {
    alpha: ["Use DI", "Pin deps"],
    beta: ["Use DI", "pin  deps", "Single only"],
  };
  assert(JSON.stringify(findCrossProjectEntries(projects, 2)) === JSON.stringify(["Pin deps", "Use DI"]), "entries in 2 projects promote once (normalized dedup, spread-first order)");
  assert(findCrossProjectEntries(projects, 3).length === 0, "threshold above distinct-project count → nothing");
  assert(findCrossProjectEntries({ alpha: ["Use DI"], beta: ["Other"] }, 2).length === 0, "no shared entries → nothing");
  assert(findCrossProjectEntries({ alpha: ["Use DI", "Use DI"], beta: ["Use DI"] }, 2).length === 1, "repeats within ONE project count once (threshold measures spread)");

  // End-to-end sweep: real project dirs under the scratch vault (readdir is
  // real fs; core reads + the global-core write go through the mocked CLI).
  const projectsRoot = join(VAULT, "wiki", "projects");
  mkdirSync(join(projectsRoot, "sweep-a", "daily"), { recursive: true });
  mkdirSync(join(projectsRoot, "sweep-b", "daily"), { recursive: true });
  writeFileSync(join(projectsRoot, "scratch.txt"), "not a project");
  try {
    projectFiles.set("wiki/projects/sweep-a/core.md", [
      "---", "type: project-core", "project: sweep-a", "created: 2026-08-07", "updated: 2026-08-07", "---", "",
      `# Project Learnings — sweep-a`, "",
      "## High-value learnings",
      "- Use DI<!--score:2-->",
      "- Pin deps<!--score:1-->",
      "",
      "## Watch-outs",
      "- Avoid: guess<!--score:1-->",
      "",
    ].join("\n"));
    projectFiles.set("wiki/projects/sweep-b/core.md", [
      "---", "type: project-core", "project: sweep-b", "created: 2026-08-07", "updated: 2026-08-07", "---", "",
      "## High-value learnings",
      "- Use DI<!--score:1-->",
      "- Pin deps<!--score:1-->",
      "- Single only<!--score:1-->",
      "",
    ].join("\n"));
    projectFiles.delete("wiki/global-core.md");

    const res = sweepPromoteGlobal(VAULT, 2);
    assert(res.promoted === 2, "sweep promotes both cross-project entries");
    const g = projectFiles.get("wiki/global-core.md") ?? "";
    assert(g.includes("- Use DI<!--from:sweep-a,sweep-b--><!--score:1-->"), "promoted bullet carries provenance marker");
    assert(g.includes("- Pin deps<!--from:sweep-a,sweep-b--><!--score:1-->"), "second promoted bullet carries provenance");
    assert(!g.includes("Single only"), "single-project entry not promoted");
    assert(!g.includes("Avoid: guess"), "watch-outs never promote");

    // Idempotent re-run: nothing new, no duplicate bullets, no score inflation.
    const beforeG = projectFiles.get("wiki/global-core.md");
    const res2 = sweepPromoteGlobal(VAULT, 2);
    assert(res2.promoted === 0, "idempotent re-run promotes nothing");
    assert(projectFiles.get("wiki/global-core.md") === beforeG, "idempotent re-run leaves global core byte-identical");

    // Threshold above the distinct-project count → nothing promoted.
    assert(sweepPromoteGlobal(VAULT, 3).promoted === 0, "threshold 3 with 2 projects → nothing promoted");

    // Read failure on one project core: that project is skipped, so the
    // shared entry no longer reaches the threshold.
    failReads.set("wiki/projects/sweep-b/core.md", "Error: boom");
    assert(sweepPromoteGlobal(VAULT, 2).promoted === 0, "project read failure → that project skipped");
    failReads.delete("wiki/projects/sweep-b/core.md");

    // /wiki promote-global command: registered with a description and wired
    // to the same sweep. The AC17-invalidation section leaves the module's
    // cached vault pointing at a scratch cwd; firing session_shutdown (which
    // clears the cache after re-resolving) makes the handler re-resolve to
    // the restored VAULT settings on its next getVaultPath().
    mock.handlers["session_shutdown"].forEach((h) => h({}, mock.ctx));
    const cmd = mock.commands.find((c) => c.name === "wiki promote-global");
    assert(!!cmd && !!cmd?.opts?.description, "/wiki promote-global registered with description");
    projectFiles.delete("wiki/global-core.md");
    await cmd.opts.handler("", mock.ctx);
    const afterCmd = projectFiles.get("wiki/global-core.md") ?? "";
    assert(afterCmd.includes("<!--from:sweep-a,sweep-b-->"), "command handler runs the sweep (provenance written)");

    // session_shutdown trigger: same sweep, runs at session end.
    projectFiles.delete("wiki/global-core.md");
    mock.handlers["session_shutdown"].forEach((h) => h({}, mock.ctx));
    const afterShutdown = projectFiles.get("wiki/global-core.md") ?? "";
    assert(afterShutdown.includes("<!--from:sweep-a,sweep-b-->"), "session_shutdown trigger runs the sweep");
  } finally {
    rmSync(projectsRoot, { recursive: true, force: true });
    projectFiles.delete("wiki/global-core.md");
    projectFiles.delete("wiki/projects/sweep-a/core.md");
    projectFiles.delete("wiki/projects/sweep-b/core.md");
    failReads.clear();
  }

  // Missing projects dir → safe no-op (no throw, no write).
  assert(sweepPromoteGlobal(VAULT, 2).promoted === 0, "no projects dir → 0 promoted, no throw");
}

section("M2 — claude settings tiers in extension resolution");
{
  // resolve-vault.sh tiers 3/4 parity: ~/.claude/settings.json vault_path is
  // honored when pi settings have no vaultPath, tilde-expanded, and gated by
  // the exists-and-is-directory check (stale paths fall through, and a stale
  // settings.local.json falls through to a valid settings.json).
  const origPi = readFileSync(join(HOME, ".pi", "agent", "settings.json"), "utf-8");
  const claudeVault = join(HOME, "claude-vault");
  mkdirSync(claudeVault, { recursive: true });
  mkdirSync(join(HOME, ".claude"), { recursive: true });
  const writeClaude = (file, opts) =>
    writeFileSync(join(HOME, ".claude", file), JSON.stringify({
      pluginConfigs: { "claude-code-agents-memo": { options: opts } },
    }));
  writeFileSync(join(HOME, ".pi", "agent", "settings.json"), JSON.stringify({
    agentsMemo: { bootstrapReadHot: "always" }, // no vaultPath
  }));
  try {
    writeClaude("settings.json", { vault_path: "~/claude-vault" });
    assert(memoMod.resolveVaultPath() === claudeVault, "claude settings vault_path resolves (tilde expanded)");
    writeClaude("settings.json", { vault_path: "~/stale-claude-vault" });
    assert(memoMod.resolveVaultPath() === null, "stale claude vault_path gated → falls through");
    // two-file fallthrough: stale local must not shadow a valid global.
    writeClaude("settings.local.json", { vault_path: "~/stale-local" });
    writeClaude("settings.json", { vault_path: "~/claude-vault" });
    assert(memoMod.resolveVaultPath() === claudeVault, "stale local claude vault_path falls through to valid global");
  } finally {
    // restore pi settings + scratch claude files for any later resolution
    writeFileSync(join(HOME, ".pi", "agent", "settings.json"), origPi);
    rmSync(join(HOME, ".claude", "settings.json"), { force: true });
    rmSync(join(HOME, ".claude", "settings.local.json"), { force: true });
  }
}

// ══════════════════════════════ agents.ts ═══════════════════════════════════
const agentsMod = await jiti.import(join(REPO, "extensions", "agents.ts"));
const { loadAgents, registerMemoDispatchTool } = agentsMod;

section("AC18 — agent discovery from agents/");
{
  const agents = loadAgents();
  const names = agents.map((a) => a.name).sort();
  assert(agents.length === 7, `7 agents discovered (got ${agents.length})`);
  assert(JSON.stringify(names) === JSON.stringify([
    "memory-capture", "memory-gather", "memory-ingest",
    "memory-lint", "memory-research-round", "memory-search", "memory-source-synth",
  ]), "all memory-* agents present");
  assert(agents.every((a) => a.description && a.systemPrompt.trim()), "every agent has description + system prompt");
}

section("AC19 — frontmatter conversion");
{
  const byName = Object.fromEntries(loadAgents().map((a) => [a.name, a]));
  const round = byName["memory-research-round"];
  assert(round.model === "deepseek-v4-pro", "sonnet → deepseek-v4-pro");
  ["bash", "find", "ls", "web_fetch", "web_search", "memo_dispatch"].forEach((t) =>
    assert(round.tools.includes(t), `research-round keeps ${t}`));
  ["read", "write", "edit", "grep"].forEach((t) =>
    assert(!round.tools.includes(t), `research-round drops ${t}`));

  const synth = byName["memory-source-synth"];
  ["bash", "read", "write"].forEach((t) =>
    assert(synth.tools.includes(t), `source-synth keeps ${t}`));
  ["edit", "grep", "web_fetch", "web_search", "memo_dispatch"].forEach((t) =>
    assert(!synth.tools.includes(t), `source-synth drops ${t}`));

  const search = byName["memory-search"];
  assert(search.model === "deepseek-v4-flash", "haiku → deepseek-v4-flash");
  ["write", "edit", "web_fetch", "web_search"].forEach((t) =>
    assert(!search.tools.includes(t), `memory-search drops ${t}`));

  const lint = byName["memory-lint"];
  assert(lint.tools.includes("write") && lint.tools.includes("grep"), "memory-lint keeps permission-allowed write + grep");
  assert(!lint.tools.includes("memo_dispatch"), "memory-lint (leaf) does not get memo_dispatch");

  assert(!loadAgents().some((a) => a.tools.includes("agent")), "Agent never appears in tool allowlists");
}

section("AC19 — allowlist edge cases (disallowed wins, memo_dispatch opt-in)");
{
  const { buildToolAllowlist } = agentsMod;
  const both = buildToolAllowlist({
    permissions: ["bash: 'allow'", "read: 'allow'"],
    disallowedTools: "Bash Read Edit",
  });
  assert(!both.includes("bash") && !both.includes("read"), "tool in both permissions and disallowedTools → rejected");
  const optIn = buildToolAllowlist({
    permissions: ["memo_dispatch: 'allow'"],
    disallowedTools: "Agent",
  });
  assert(optIn.includes("memo_dispatch"), "memo_dispatch granted when explicitly permission-listed");
  const noOptIn = buildToolAllowlist({ permissions: ["bash: 'allow'"], disallowedTools: "Agent" });
  assert(!noOptIn.includes("memo_dispatch"), "memo_dispatch not granted without explicit permission");
  const disallowedOptIn = buildToolAllowlist({
    permissions: ["memo_dispatch: 'allow'"],
    disallowedTools: "Agent memo_dispatch",
  });
  assert(!disallowedOptIn.includes("memo_dispatch"), "memo_dispatch rejected when also disallowed");
}

section("AC20/21 — memo_dispatch registration + modes");
{
  const mock2 = createMockPi();
  registerMemoDispatchTool(mock2.pi);
  assert(mock2.tools.length === 1, "one tool registered");
  const tool = mock2.tools[0];
  assert(tool.name === "memo_dispatch", "registered as memo_dispatch");
  assert(typeof tool.execute === "function", "execute handler present");
  // Provider-safe flat object schema: top-level type must be "object" (a
  // Type.Union emits {anyOf:[...]} with type:null, which OpenAI-compatible
  // providers like DeepSeek reject with HTTP 400).
  assert(tool.parameters.type === "object", "memo_dispatch schema has top-level type: object");
  const props = tool.parameters.properties ?? {};
  for (const k of ["mode", "agent", "task", "tasks", "chain", "cwd"]) {
    assert(k in props, `memo_dispatch schema declares ${k}`);
  }

  // empty call (valid against the flat optional schema) → clear error, no crash
  calls.spawn.length = 0;
  const resEmpty = await tool.execute("x", {}, undefined, undefined, { cwd: REPO });
  assert(resEmpty.details.mode === "invalid", "empty call → invalid mode result");
  assert(calls.spawn.length === 0, "empty call → no spawn");

  // unknown agent → fails fast, no subprocess spawn
  calls.spawn.length = 0;
  const res = await tool.execute("x", { agent: "ghost", task: "hi" }, undefined, undefined, { cwd: REPO });
  assert(res.details.mode === "single", "single mode result");
  assert(res.details.results[0].exitCode === 1, "unknown agent → exit 1");
  assert(/Unknown agent "ghost"/.test(res.details.results[0].stderr), "unknown agent → clear error");
  assert(calls.spawn.length === 0, "unknown agent → no spawn");

  // single mode → spawn with mapped model + allowlist + system prompt
  calls.spawn.length = 0;
  spawnOutputs.splice(0, spawnOutputs.length, "single result");
  const res2 = await tool.execute("x", { agent: "memory-search", task: "answer Q", cwd: REPO }, undefined, undefined, { cwd: REPO });
  assert(calls.spawn.length === 1, "single mode spawns one subprocess");
  const args = calls.spawn[0].args;
  assert(args.includes("--model") && args[args.indexOf("--model") + 1] === "deepseek-v4-flash", "model mapped to deepseek-v4-flash");
  const toolsArg = args[args.indexOf("--tools") + 1];
  assert(!toolsArg.split(",").includes("write") && !toolsArg.split(",").includes("memo_dispatch"), "memory-search tools allowlist excludes write + memo_dispatch");
  assert(args.includes("--system-prompt"), "system prompt passed");
  assert(args.at(-1) === "Task: answer Q", "task passed as final prompt");
  assert(res2.details.results[0].exitCode === 0 && res2.content[0].text.includes("single result"), "single mode returns subagent output");

  // parallel mode → one spawn per task
  calls.spawn.length = 0;
  spawnOutputs.splice(0, spawnOutputs.length, "p1", "p2");
  const res3 = await tool.execute("x", { tasks: [{ agent: "memory-gather", task: "g1" }, { agent: "memory-gather", task: "g2" }], cwd: REPO }, undefined, undefined, { cwd: REPO });
  assert(calls.spawn.length === 2, "parallel mode spawns per task");
  assert(res3.details.mode === "parallel", "parallel mode result");

  // chain mode → {previous} replaced with prior step output
  calls.spawn.length = 0;
  spawnOutputs.splice(0, spawnOutputs.length, "step one out", "step two out");
  const res4 = await tool.execute("x", { chain: [{ agent: "memory-gather", task: "step one" }, { agent: "memory-gather", task: "refine: {previous}" }], cwd: REPO }, undefined, undefined, { cwd: REPO });
  assert(calls.spawn.length === 2, "chain mode runs sequentially");
  assert(calls.spawn[1].args.at(-1) === "Task: refine: step one out", "chain replaces {previous} with prior output");
  assert(res4.details.mode === "chain", "chain mode result");

  // chain mode with $-patterns in prior output: $&, $', $`, $1 must survive
  // the {previous} substitution. A string-replacement replacer would mangle
  // them (the arrow-function replacer is required).
  calls.spawn.length = 0;
  spawnOutputs.splice(0, spawnOutputs.length, "cost $5 and $& and $' and $` tail", "step two out");
  await tool.execute("x", { chain: [{ agent: "memory-gather", task: "first" }, { agent: "memory-gather", task: "refine: {previous}" }], cwd: REPO }, undefined, undefined, { cwd: REPO });
  assert(
    calls.spawn[1].args.at(-1) === "Task: refine: cost $5 and $& and $' and $` tail",
    `chain {previous} preserves $-patterns in prior output (got: ${calls.spawn[1]?.args?.at(-1)})`,
  );
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n=== summary ===`);
console.log(`  pass=${passCount}  fail=${failCount}`);
process.exit(failCount === 0 ? 0 : 1);
