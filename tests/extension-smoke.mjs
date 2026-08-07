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
//   PM      per-project memory: slug derivation, reflection subprocess,
//           project daily + core.md pipeline, legacy fallback, core.md
//           parse/merge/render pure functions, before_agent_start + compact
//           injection of project core.md
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
// Stateful simulation of the wiki/projects/<slug>/ subtree (project memory):
// reads return what prior overwrites stored, so core.md merge/dedup/score can
// be asserted end-to-end without Obsidian. Content is shell-decoded the same
// way the real obsidian CLI round-trips literal \n → newline.
const projectFiles = new Map();
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
  const projRead = c.match(/read "?path=(wiki\/projects\/[^\s"]+)/);
  if (projRead) return projectFiles.get(projRead[1]) ?? "";
  const projCreate = c.match(/create path=(wiki\/projects\/[^\s"]+) overwrite=true content="((?:[^"\\]|\\.)*)"/);
  if (projCreate) {
    projectFiles.set(projCreate[1], decodeShell(projCreate[2]));
    return `Created: ${projCreate[1]}\n`;
  }
  if (c.includes("create-or-append")) return "";
  return "";
};
// Synchronous git restore used by the AC13 hot-cache guard (spawnSync — no
// shell interpolation of the vault path). Also serves the project-memory
// reflection subprocess: any pi --mode json invocation returns a canned
// reflection as pi's JSON-lines message_end event.
const REFLECTION_OUTPUT = { mistakes: ["m1", "m2"], fixes: ["f1", "f2"] };
cp.spawnSync = (command, args) => {
  calls.exec.push([command, ...args].join(" "));
  if (args.includes("wiki/hot.md")) {
    // simulate a successful git restore from HEAD
    writeFileSync(join(VAULT, "wiki", "hot.md"), "hot cache restored\n");
  } else if (args.includes("--mode") && args.includes("json")) {
    const text = JSON.stringify(REFLECTION_OUTPUT);
    return {
      status: 0,
      stdout: JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] }}) + "\n",
      stderr: "",
    };
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
  const sent = [];
  const execs = [];
  let gitDirty = false;
  let notifyCount = 0;
  const pi = {
    on(event, fn) { (handlers[event] ??= []).push(fn); },
    registerTool(tool) { tools.push(tool); },
    sendMessage(msg, opts) { sent.push({ msg, opts }); },
    exec(cmd, args) {
      execs.push([cmd, ...args]);
      if (cmd === "git" && args[2] === "status") {
        return Promise.resolve({ code: 0, stdout: gitDirty ? " M wiki/hot.md\n" : "" });
      }
      return Promise.resolve({ code: 0, stdout: "" });
    },
  };
  const ctx = { hasUI: true, cwd: REPO, ui: { notify: () => { notifyCount++; } } };
  return {
    pi, handlers, tools, sent, execs,
    setGitDirty: (d) => { gitDirty = d; },
    notifyCount: () => notifyCount,
    ctx,
  };
}

const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });

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

section("AC16/17 — write-verb touched tracking");
{
  // Consume the per-run flag via agent_end (it resets the flag now, not
  // agent_settled) so this section starts from a clean slate.
  mock.setGitDirty(false);
  mock.handlers["agent_end"].forEach((h) => h(agentEndEv(), mock.ctx));
  const appends = () => calls.exec.filter((c) => c.includes("create-or-append"));
  const before = appends().length;
  const readEv = { toolCallId: "t-r", toolName: "bash", input: { command: `obsidian read path=wiki/hot.md` } };
  mock.handlers["tool_call"][0](readEv, mock.ctx);
  mock.handlers["agent_end"].forEach((h) => h(agentEndEv(), mock.ctx));
  assert(appends().length === before, "read-only session → no reflection append");
  const writeEv = { toolCallId: "t-w", toolName: "bash", input: { command: `obsidian create path=wiki/concepts/x.md content="hello"` } };
  mock.handlers["tool_call"][0](writeEv, mock.ctx);
  mock.handlers["agent_end"].forEach((h) => h(agentEndEv(), mock.ctx));
  assert(appends().length === before + 1, "write verb → agent_end reflection appended");
  assert(/daily\/\d{4}-\d{2}-\d{2}\.md/.test(appends().at(-1) ?? ""), "reflection targets daily/YYYY-MM-DD.md");
  // eval write verb (parity with log-obsidian-calls.sh's auto-commit verbs).
  const evalEv = { toolCallId: "t-eval", toolName: "bash", input: { command: `obsidian eval code="1"` } };
  mock.handlers["tool_call"][0](evalEv, mock.ctx);
  mock.handlers["agent_end"].forEach((h) => h(agentEndEv(), mock.ctx));
  assert(appends().length === before + 2, "eval verb → agent_end reflection appended");
  // non-write verb (read) after a pipe to a write word must NOT touch (verb is
  // extracted positionally, mirroring log-obsidian-calls.sh).
  const pipeEv = { toolCallId: "t-pipe", toolName: "bash", input: { command: `obsidian read path=wiki/hot.md | grep append` } };
  mock.handlers["tool_call"][0](pipeEv, mock.ctx);
  mock.handlers["agent_end"].forEach((h) => h(agentEndEv(), mock.ctx));
  assert(appends().length === before + 2, "read | grep append → no reflection (positional verb extraction)");
  // compound already-routed command: the LAST write verb wins (parity with
  // log-obsidian-calls.sh's greedy `s/.*obsidian-cli\.sh[^[:space:]]* //`).
  const compoundEv = { toolCallId: "t-compound", toolName: "bash", input: { command: `"${REPO}/scripts/obsidian-cli.sh" read path=wiki/hot.md && "${REPO}/scripts/obsidian-cli.sh" append file=wiki/hot.md content="x"` } };
  mock.handlers["tool_call"][0](compoundEv, mock.ctx);
  mock.handlers["agent_end"].forEach((h) => h(agentEndEv(), mock.ctx));
  assert(appends().length === before + 3, "compound read && append → reflection appended (last verb wins)");
  // env-prefixed raw command (FOO=bar obsidian ...): bash strips leading
  // KEY=val assignments before extracting the verb — the extension must too.
  const envEv = { toolCallId: "t-env", toolName: "bash", input: { command: `FOO=bar obsidian append file=wiki/hot.md content="x"` } };
  mock.handlers["tool_call"][0](envEv, mock.ctx);
  mock.handlers["agent_end"].forEach((h) => h(agentEndEv(), mock.ctx));
  assert(appends().length === before + 4, "env-prefixed obsidian append → reflection appended");
  // trailing wrapper with no verb: bash's greedy regex backtracks to the
  // prior wrapper occurrence and still extracts the verb.
  const trailEv = { toolCallId: "t-trail", toolName: "bash", input: { command: `"${REPO}/scripts/obsidian-cli.sh" append file=wiki/hot.md content="x" && "${REPO}/scripts/obsidian-cli.sh"` } };
  mock.handlers["tool_call"][0](trailEv, mock.ctx);
  mock.handlers["agent_end"].forEach((h) => h(agentEndEv(), mock.ctx));
  assert(appends().length === before + 5, "trailing wrapper backtracks to prior verb → reflection appended");
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
  // AC-PM: project core.md injected when projectMemory enabled (default true),
  // sourced from wiki/projects/<slug>/core.md via the obsidian CLI.
  const coreMsg = results.find((r) => r.message.customType === "agents-memo-project-core")?.message;
  assert(!!coreMsg, "project core.md injected when projectMemory enabled (default)");
  assert(coreMsg?.display === false, "project core message display:false");
  assert(coreMsg?.content.includes("project memory for "), "project core injected with slug prefix");
  assert(coreMsg?.content.includes("Keep edits small"), "project core content from vault core.md");
}

section("AC11 — session_compact re-injection");
{
  mock.handlers["session_compact"].forEach((h) => h({}, mock.ctx));
  const hotSends = mock.sent.filter((s) => s.msg.customType === "agents-memo-hot");
  assert(hotSends.length === 1, "hot.md re-injected via sendMessage");
  assert(hotSends[0]?.opts?.triggerTurn === false, "re-injection does not trigger a turn");
  assert(!mock.sent.some((s) => s.msg.customType === "agents-memo-index"), "index.md not re-injected (on-demand)");
  // AC-PM: project core re-injected from the slug cached at before_agent_start.
  const coreSends = mock.sent.filter((s) => s.msg.customType === "agents-memo-project-core");
  assert(coreSends.length === 1, "project core.md re-injected on session_compact");
  assert(coreSends[0]?.opts?.triggerTurn === false, "project core re-injection does not trigger a turn");
  assert(coreSends[0]?.msg.content.includes("project memory for "), "project core re-injection has slug prefix");
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

  // clean repo → status checked but no commit, no notify
  mock.setGitDirty(false);
  const writeEv2 = { toolCallId: "t-c2", toolName: "bash", input: { command: `obsidian append file=wiki/hot.md content="y"` } };
  mock.handlers["tool_call"][0](writeEv2, mock.ctx);
  const before = mock.execs.length;
  await settled();
  assert(!mock.execs.slice(before).some((e) => e[0] === "git" && (e.includes("add") || e.includes("commit"))), "clean repo → no git add/commit");
  assert(mock.notifyCount() === 1, "clean repo → no notification");

  // flag consumed by agent_end → subsequent settled() with no writes commits nothing
  mock.handlers["agent_end"].forEach((h) => h({}, mock.ctx));
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
  mock.handlers["agent_end"].forEach((h) => h({}, mock.ctx)); // agent_end consumes the flag first
  const before3 = mock.execs.length;
  await settled();
  assert(mock.execs.slice(before3).some((e) => e[0] === "git" && e.includes("commit")), "auto-commit still fires after agent_end (write → agent_end → agent_settled)");
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
  mock.handlers["agent_end"].forEach((h) => h({ messages: [] }, mock.ctx));
  const execBefore = calls.exec.length;
  const writeEv = { toolCallId: "t-pm1", toolName: "bash", input: { command: `obsidian create path=wiki/concepts/pm.md content="x"` } };
  mock.handlers["tool_call"][0](writeEv, mock.ctx);
  const conv = [
    { role: "user", content: "fix the merge bug", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "I changed the merge logic" }], timestamp: 2 },
  ];
  mock.handlers["agent_end"].forEach((h) => h({ messages: conv }, mock.ctx));
  const slice = calls.exec.slice(execBefore);

  const spawn = slice.find((c) => c.includes("--no-session"));
  assert(!!spawn, "agent_end spawns reflection subprocess");
  assert(spawn?.includes("--mode json"), "reflection spawns pi --mode json");
  assert(spawn?.includes("--provider deepseek"), "reflection uses reflectModel provider");
  assert(spawn?.includes("--model deepseek-v4-flash"), "reflection uses reflectModel id");
  assert(spawn?.includes("<conversation>"), "reflection prompt embeds conversation");
  assert(spawn?.includes("Assistant: I changed the merge logic"), "reflection conversation serialized");

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

section("project-memory — enabled=false falls back to legacy daily marker");
{
  const origPi = readFileSync(join(HOME, ".pi", "agent", "settings.json"), "utf-8");
  writeFileSync(join(HOME, ".pi", "agent", "settings.json"), JSON.stringify({
    agentsMemo: { vaultPath: VAULT, projectMemory: { enabled: false } },
  }));
  try {
    mock.handlers["agent_end"].forEach((h) => h({ messages: [] }, mock.ctx)); // consume residual flag
    const execBefore = calls.exec.length;
    const writeEv = { toolCallId: "t-pm2", toolName: "bash", input: { command: `obsidian create path=wiki/concepts/legacy.md content="x"` } };
    mock.handlers["tool_call"][0](writeEv, mock.ctx);
    mock.handlers["agent_end"].forEach((h) => h(agentEndEv(), mock.ctx));
    const slice = calls.exec.slice(execBefore);
    const appends = slice.filter((c) => c.includes("create-or-append"));
    assert(appends.length === 1, "enabled=false → legacy global daily append");
    assert(/daily\/\d{4}-\d{2}-\d{2}\.md/.test(appends[0] ?? ""), "legacy append targets global daily/YYYY-MM-DD.md");
    assert(!(appends[0] ?? "").includes("wiki/projects/"), "legacy append is NOT project-scoped");
    assert(!slice.some((c) => c.includes("--no-session")), "enabled=false → no reflection subprocess spawned");
  } finally {
    writeFileSync(join(HOME, ".pi", "agent", "settings.json"), origPi);
  }
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
