/**
 * agents-memo pi extension
 *
 * Pi port of the Claude Code hooks in hooks/hooks.json. Handles:
 *   - tool_call: rewrites ${MEMO_PLUGIN_PWD} and leading `obsidian` calls to
 *     scripts/obsidian-cli.sh, blocks daily/*.md overwrites (issue #98), and
 *     blocks direct read/write/edit on vault paths.
 *   - before_agent_start / session_compact: injects _shared/INIT.md and the
 *     hot cache / index when bootstrap config says "always".
 *   - tool_execution_end: guards wiki/hot.md against silent 0-byte corruption.
 *   - agent_settled: auto-commits vault git changes and notifies.
 *   - agent_end / session_shutdown: appends session reflections to daily notes.
 *
 * API surface: @earendil-works/pi-coding-agent (installed pi@0.83.0). Validated
 * with `tsc --noEmit --strict` against the installed package's dist types.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentSettledEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// ─── Plugin root ──────────────────────────────────────────────────────────────
// The extension lives at <pluginRoot>/extensions/agents-memo.ts; the plugin
// root is one level up. jiti loads this module as ESM, so import.meta.url is
// the authoritative location even when the package is installed elsewhere.
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─── Settings ─────────────────────────────────────────────────────────────────
interface AgentsMemoConfig {
  vaultPath?: string;
  bootstrapReadHot?: "always" | "on-demand" | "never";
  bootstrapReadIndex?: "always" | "on-demand" | "never";
  autoCommit?: boolean;
}

function readPiSettings(): AgentsMemoConfig {
  // Per-key first-wins, matching resolve-vault.sh / resolve-config.sh tier
  // 0a/0b: for each key the global file (~/.pi/agent/settings.json) wins; the
  // project file (.pi/settings.json) only fills keys the global file leaves
  // undefined. A global block that defines only autoCommit must not shadow a
  // project vaultPath.
  const files = [
    join(homedir(), ".pi", "agent", "settings.json"),
    join(process.cwd(), ".pi", "settings.json"),
  ];
  const merged: AgentsMemoConfig = {};
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(f, "utf-8"));
      const block = parsed?.agentsMemo;
      if (!block || typeof block !== "object") continue;
      if (typeof block.vaultPath === "string" && merged.vaultPath === undefined) merged.vaultPath = block.vaultPath;
      if ((block.bootstrapReadHot === "always" || block.bootstrapReadHot === "on-demand" || block.bootstrapReadHot === "never") && merged.bootstrapReadHot === undefined) {
        merged.bootstrapReadHot = block.bootstrapReadHot;
      }
      if ((block.bootstrapReadIndex === "always" || block.bootstrapReadIndex === "on-demand" || block.bootstrapReadIndex === "never") && merged.bootstrapReadIndex === undefined) {
        merged.bootstrapReadIndex = block.bootstrapReadIndex;
      }
      if (typeof block.autoCommit === "boolean" && merged.autoCommit === undefined) merged.autoCommit = block.autoCommit;
    } catch {
      // missing or unparseable - skip
    }
  }
  return merged;
}

function expandTilde(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

// Parity with resolve-vault.sh tiers 3/4: Claude Code settings fall back after
// pi settings and CWD discovery, keyed by pluginConfigs[*agents-memo*]. The
// exists + isDirectory gate lives here (not in the caller) so a stale
// vault_path in settings.local.json falls through to a valid settings.json,
// matching resolve-vault.sh's per-file gate. Within a file, later valid
// entries win here — intentionally diverging from bash's head -1, which gates
// the whole file on its first matching entry. Exported for the smoke test (pi
// only invokes the default export).
export function readClaudeVaultPath(): string | null {
  for (const f of [join(homedir(), ".claude", "settings.local.json"), join(homedir(), ".claude", "settings.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(f, "utf-8"));
      const pluginConfigs = parsed?.pluginConfigs;
      if (!pluginConfigs || typeof pluginConfigs !== "object") continue;
      for (const [key, val] of Object.entries(pluginConfigs)) {
        const options = (val as { options?: { vault_path?: unknown } })?.options;
        if (key.includes("agents-memo") && typeof options?.vault_path === "string") {
          const expanded = expandTilde(options.vault_path);
          if (existsSync(expanded) && statSync(expanded).isDirectory()) {
            return expanded;
          }
          // stale path in this file — keep scanning lower tiers
        }
      }
    } catch {
      // missing or unparseable - skip
    }
  }
  return null;
}

// Exported for the smoke test (pi only invokes the default export).
export function resolveVaultPath(): string | null {
  const config = readPiSettings();
  if (config.vaultPath) {
    const expanded = expandTilde(config.vaultPath);
    if (existsSync(expanded) && statSync(expanded).isDirectory()) {
      return expanded;
    }
  }
  // Fallback: CWD contains a wiki/ subdirectory (resolve-vault.sh tier 2).
  const cwdWiki = join(process.cwd(), "wiki");
  if (existsSync(cwdWiki) && statSync(cwdWiki).isDirectory()) {
    return process.cwd();
  }
  // Fallback: Claude Code settings (resolve-vault.sh tiers 3/4) — already
  // validated (exists + directory) inside readClaudeVaultPath.
  return readClaudeVaultPath();
}

// ─── Content cache ────────────────────────────────────────────────────────────
let initContent: string | null = null;

function getInitContent(): string {
  if (initContent !== null) return initContent;
  try {
    const raw = readFileSync(join(pluginRoot, "_shared", "INIT.md"), "utf-8");
    // INIT.md references the plugin root via ${MEMO_PLUGIN_PWD} (migrated from
    // ${CLAUDE_PLUGIN_ROOT}); both must resolve to the real path at injection
    // time, mirroring the envsubst step in hooks/hooks.json.
    initContent = raw
      .replace(/\$\{MEMO_PLUGIN_PWD\}/g, pluginRoot)
      .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot);
  } catch {
    initContent = "";
  }
  return initContent;
}

function execObsidianRead(vaultPath: string, relPath: string): string | null {
  try {
    const obsCli = join(pluginRoot, "scripts", "obsidian-cli.sh");
    return execSync(`bash "${obsCli}" read "path=${relPath}"`, {
      cwd: vaultPath,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

// ─── Bypass allowlist for direct vault I/O ─────────────────────────────────────
// Mirrors the exceptions in hooks/block-direct-vault-io.sh: binary attachments,
// canvas files, the manifest, and lint admin artifacts cannot go through the
// CLI's text verbs.
// Most-specific rules first: .raw/.manifest.json (read/write/edit) must be
// checked before the read-only .raw/** rule, mirroring the bash hook's
// Write|Edit branch where only the manifest (not .raw/*) is allowed.
const VAULT_IO_BYPASS: Array<{ pattern: RegExp; tools: string[] }> = [
  { pattern: /^\.raw\/\.manifest\.json$/, tools: ["read", "write", "edit"] },
  { pattern: /^\.raw\/.*/, tools: ["read"] },
  { pattern: /^_attachments\/.*/, tools: ["read", "write", "edit"] },
  { pattern: /\.canvas$/, tools: ["read", "write", "edit"] },
  { pattern: /^wiki\/meta\/lint-data-.*\.json$/, tools: ["write", "edit"] },
];

function isVaultBypassed(vaultRelativePath: string, toolName: string): boolean {
  for (const entry of VAULT_IO_BYPASS) {
    if (entry.pattern.test(vaultRelativePath)) {
      return entry.tools.includes(toolName.toLowerCase());
    }
  }
  return false;
}

// Realpath both sides with a fallback for missing paths. Parity with the bash
// hook's `realpath -ms` (symlinks preserved, existence not required): walk up
// to the longest existing ancestor, realpath it, and re-append the unresolved
// tail, so a NEW-file write inside a symlinked vault still hits containment
// instead of escaping via the un-resolved symlink prefix.
function realpathOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    let ancestor = p;
    const tail: string[] = [];
    for (;;) {
      try {
        return join(realpathSync(ancestor), ...tail);
      } catch {
        const parent = dirname(ancestor);
        if (parent === ancestor) return resolve(p);
        tail.unshift(basename(ancestor));
        ancestor = parent;
      }
    }
  }
}

// Normalized containment check: returns the realpath-normalized (file, vault)
// pair when filePath is inside vaultPath, or null. Separator boundary so
// /home/u/wiki does not match /home/u/wiki2 (parity with `realpath -ms` +
// prefix check in the bash hook). The vault root itself is allowed through,
// matching block-direct-vault-io.sh whose `"$VAULT"/*` literal-prefix checks
// never match the root. One realpath walk per side serves both the block
// decision and the bypass-allowlist rel path.
function vaultContainedPair(filePath: string, vaultPath: string): { abs: string; vaultAbs: string } | null {
  const abs = realpathOrResolve(resolve(process.cwd(), filePath));
  const vaultAbs = realpathOrResolve(resolve(vaultPath));
  const prefix = vaultAbs.endsWith("/") ? vaultAbs : vaultAbs + "/";
  return abs.startsWith(prefix) ? { abs, vaultAbs } : null;
}

// ─── Write-verb detection (touched tracking) ─────────────────────────────────
// Write-verb class mirrors hooks/log-obsidian-calls.sh's auto-commit verbs
// (create, append, prepend, create-or-append, property:set, property:remove,
// eval) plus `overwrite` (a create flag; harmless to over-match).
const WRITE_VERB_RE = /\b(create|create-or-append|append|prepend|overwrite|property:set|property:remove|eval)\b/;

// Extract the obsidian verb positionally, mirroring log-obsidian-calls.sh's
// VERB extraction: for routed commands the first token AFTER the LAST wrapper
// occurrence that has a follower (bash's greedy `s/.*obsidian-cli\.sh
// [^[:space:]]* //` backtracks past a trailing wrapper with no verb); for raw
// commands, strip leading KEY=val assignments (bash sed #2) and take the
// token after a leading `obsidian`. This keeps `obsidian read ... | grep
// append` from counting as a write while compound commands (read && append)
// still detect the last write verb.
function extractVerb(cmd: string): string | null {
  const joined = cmd
    .replace(/\\\r?\n/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ content=[^\s]*/g, "")
    .replace(/ template=[^\s]*/g, "");
  const tokens = joined.split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].includes("obsidian-cli.sh") && tokens[i + 1] !== undefined) {
      return tokens[i + 1];
    }
  }
  let idx = stripEnvPrefix(tokens);
  if (tokens[idx] === "obsidian") return tokens[idx + 1] ?? null;
  return null;
}

// Index of the first non-env-prefix token (strips leading KEY=val
// assignments, mirroring log-obsidian-calls.sh's CMD_NOENV stripping). Shared
// by extractVerb and isObsidianRouted so the two never diverge.
function stripEnvPrefix(tokens: string[]): number {
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++;
  return idx;
}

// True when the command routes through obsidian — via the rewritten wrapper
// path, or as a raw command with a leading `obsidian` token after stripping
// leading KEY=val assignments (log-obsidian-calls.sh's CMD_NOENV gate).
function isObsidianRouted(cmd: string): boolean {
  if (cmd.includes("obsidian-cli.sh")) return true;
  const tokens = cmd.split(/\s+/);
  return tokens[stripEnvPrefix(tokens)] === "obsidian";
}

// ─── Session state ────────────────────────────────────────────────────────────
let vaultTouched = false; // vault touched during the current agent run
let sessionTouched = false; // vault touched at any point this session
let vaultPathCached: string | null = null;
// toolCallId → bash command (tool_execution_end has no input field; the guard
// needs the command text to know whether hot.md was involved).
const bashCommands = new Map<string, string>();

function getVaultPath(): string | null {
  if (vaultPathCached === null) {
    vaultPathCached = resolveVaultPath();
  }
  return vaultPathCached;
}

// ─── Daily overwrite guard (issue #98) ────────────────────────────────────────
// Parity with hooks/obsidian-cli-rewrite.sh: checked on the command BEFORE the
// leading-obsidian rewrite, already-routed commands (mentioning obsidian-cli)
// pass through (the bash hook early-exits on them), `obsidian` must appear
// before `create` (bash glob `*obsidian*create*`), and the daily path class
// mirrors the bash grep `path=("?)daily/[^[:space:]"]*\.md`.
function isDailyOverwrite(command: string): boolean {
  if (command.includes("obsidian-cli")) return false;
  const obsIdx = command.indexOf("obsidian");
  const createIdx = command.indexOf("create");
  if (obsIdx === -1 || createIdx === -1 || createIdx < obsIdx) return false;
  const hasDailyPath = /path=("?)daily\/[^\s"]*\.md/.test(command);
  const hasOverwrite = /overwrite=true|overwrite=1|overwrite(\s|$)/.test(command);
  return hasDailyPath && hasOverwrite;
}

// ─── Reflection helper ────────────────────────────────────────────────────────
function appendDailyReflection(vaultPath: string, label: string): void {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5);
  try {
    const obsCli = join(pluginRoot, "scripts", "obsidian-cli.sh");
    const template =
      "---\\ntype: daily\\ndate: " + dateStr +
      "\\ncreated: " + dateStr + "\\nupdated: " + dateStr +
      "\\n---\\n\\n## Captures\\n";
    execSync(
      `bash "${obsCli}" create-or-append ` +
        `file=daily/${dateStr}.md ` +
        `template="${template}" ` +
        `content="- ${timeStr} ${label}"`,
      { cwd: vaultPath, encoding: "utf-8", timeout: 10000 },
    );
  } catch {
    // best-effort reflection - never fail the agent loop
  }
}

// ─── Extension entry point ────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  // ── AC5/AC6/AC7/AC12: tool_call (rewrite + block) ──────────────────────────
  pi.on("tool_call", (event: ToolCallEvent, _ctx: ExtensionContext): ToolCallEventResult | void => {
    const vaultPath = getVaultPath();

    if (isToolCallEventType("bash", event)) {
      let cmd = event.input.command;

      // AC5: ${MEMO_PLUGIN_PWD} → plugin root (exact and bare forms).
      cmd = cmd.replace(/\$\{MEMO_PLUGIN_PWD\}/g, pluginRoot);
      cmd = cmd.replace(/\$MEMO_PLUGIN_PWD\b/g, pluginRoot);

      // AC7: daily overwrite guard (issue #98) — runs on the raw command
      // BEFORE the leading-obsidian rewrite, matching obsidian-cli-rewrite.sh
      // which detects the violation pre-rewrite and skips already-routed
      // commands.
      if (isDailyOverwrite(cmd)) {
        return {
          block: true,
          reason:
            "obsidian create overwrite=true on daily/*.md is forbidden (issue #98). " +
            "Use obsidian create-or-append for appends or obsidian property:set for property updates.",
        };
      }

      // AC6: leading `obsidian` → scripts/obsidian-cli.sh, first token only.
      // Leading whitespace is horizontal-only ([ \t]*) and there is no /m
      // flag, so heredoc / multi-line bodies are never rewritten (parity with
      // the bash hook's line-1-scoped `sed '1 s~^([[:space:]]*)obsidian...'`).
      cmd = cmd.replace(
        /^([ \t]*)obsidian(\s+|$)/,
        `$1"${pluginRoot}/scripts/obsidian-cli.sh"$2`,
      );

      event.input.command = cmd;
      bashCommands.set(event.toolCallId, cmd);
      // Bound the map: aborted runs never reach tool_execution_end, so evict
      // the oldest entry once the cap is exceeded (FIFO via Map order).
      if (bashCommands.size > 500) {
        bashCommands.delete(bashCommands.keys().next().value as string);
      }
      // Only actual mutations set the touched flags - reads (obsidian read,
      // grep, outline, ...) must not record a misleading "vault modified"
      // reflection. Write-verb parity with hooks/log-obsidian-calls.sh: the
      // verb is extracted positionally (first token after the last wrapper),
      // so `obsidian read ... | grep append` does not count as a write.
      const mentionsVault = isObsidianRouted(cmd) || (vaultPath !== null && cmd.includes(vaultPath));
      if (mentionsVault) {
        const verb = extractVerb(cmd);
        if (verb !== null && WRITE_VERB_RE.test(verb)) {
          vaultTouched = true;
          sessionTouched = true;
        }
      }
    }

    // AC12: block direct file I/O on vault paths (bypass allowlist applies).
    if (vaultPath !== null && (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit")) {
      const raw = (event.input as { file_path?: string; path?: string });
      const filePath = String(raw.file_path ?? raw.path ?? "");
      if (filePath) {
        const pair = vaultContainedPair(filePath, vaultPath);
        if (pair) {
          // Bypass-allowlist rel path from the same realpath-normalized values
          // used by containment (parity with block-direct-vault-io.sh, which
          // realpaths both sides first), so symlinked vaults classify
          // .raw/_attachments correctly.
          const rel = pair.abs.slice(pair.vaultAbs.length + 1);
          if (!isVaultBypassed(rel, event.toolName)) {
            const verbMap: Record<string, string> = {
              read: "obsidian read path=<file>",
              write: "obsidian create path=<file> content=\"...\"",
              edit: "obsidian create path=<file> overwrite=true content=\"...\" (full content replacement)",
            };
            return {
              block: true,
              reason: `Direct ${event.toolName} on vault paths is blocked. Use ${verbMap[event.toolName] ?? "obsidian CLI"} instead.`,
            };
          }
        }
      }
    }

    return undefined; // allow
  });

  // ── AC8: inject _shared/INIT.md as a persistent hidden message ─────────────
  // before_agent_start fires once per prompt, not once per session; a
  // session-scoped latch (set via setImmediate so every handler of the first
  // prompt still injects) limits INIT/hot/index injection to the first prompt,
  // matching the Claude Code SessionStart + PostCompact model. session_compact
  // re-injection below is unaffected by the latch.
  let bootstrapServed = false;
  const isSessionBootstrap = () => {
    if (bootstrapServed) return false;
    // All handlers of one emit complete within the current task; flip the
    // latch only after the emit finishes so INIT + hot + index all inject on
    // the first prompt.
    setImmediate(() => { bootstrapServed = true; });
    return true;
  };

  pi.on("before_agent_start", (_event, _ctx): BeforeAgentStartEventResult | void => {
    if (!isSessionBootstrap()) return;
    const init = getInitContent();
    if (!init) return;
    return {
      message: {
        customType: "agents-memo-init",
        content: `[agents-memo: _shared/INIT.md]\n${init}`,
        display: false,
      },
    };
  });

  // ── AC9: inject wiki/hot.md when bootstrapReadHot = "always" ────────────────
  pi.on("before_agent_start", (_event, _ctx): BeforeAgentStartEventResult | void => {
    if (!isSessionBootstrap()) return;
    if (readPiSettings().bootstrapReadHot !== "always") return;
    const vaultPath = getVaultPath();
    if (!vaultPath) return;
    const hot = execObsidianRead(vaultPath, "wiki/hot.md");
    if (!hot) return;
    return {
      message: {
        customType: "agents-memo-hot",
        content: `[agents-memo: wiki/hot.md]\n${hot}`,
        display: false,
      },
    };
  });

  // ── AC10: inject wiki/index.md when bootstrapReadIndex = "always" ───────────
  pi.on("before_agent_start", (_event, _ctx): BeforeAgentStartEventResult | void => {
    if (!isSessionBootstrap()) return;
    if (readPiSettings().bootstrapReadIndex !== "always") return;
    const vaultPath = getVaultPath();
    if (!vaultPath) return;
    const index = execObsidianRead(vaultPath, "wiki/index.md");
    if (!index) return;
    return {
      message: {
        customType: "agents-memo-index",
        content: `[agents-memo: wiki/index.md]\n${index}`,
        display: false,
      },
    };
  });

  // ── AC11: session_compact re-injects hot.md / index.md per bootstrap config ─
  pi.on("session_compact", (_event: SessionCompactEvent) => {
    const config = readPiSettings();
    const vaultPath = getVaultPath();
    if (!vaultPath) return;

    if (config.bootstrapReadHot === "always") {
      const hot = execObsidianRead(vaultPath, "wiki/hot.md");
      if (hot) {
        pi.sendMessage(
          { customType: "agents-memo-hot", content: `[agents-memo: wiki/hot.md]\n${hot}`, display: false },
          { triggerTurn: false },
        );
      }
    }
    if (config.bootstrapReadIndex === "always") {
      const index = execObsidianRead(vaultPath, "wiki/index.md");
      if (index) {
        pi.sendMessage(
          { customType: "agents-memo-index", content: `[agents-memo: wiki/index.md]\n${index}`, display: false },
          { triggerTurn: false },
        );
      }
    }
  });

  // ── AC13: tool_execution_end - hot-cache guard (0-byte corruption) ─────────
  pi.on("tool_execution_end", (event: ToolExecutionEndEvent, _ctx: ExtensionContext) => {
    const vaultPath = getVaultPath();
    if (!vaultPath || event.toolName !== "bash") return;

    const cmd = bashCommands.get(event.toolCallId);
    bashCommands.delete(event.toolCallId);
    // Only commands that reference wiki/hot.md can have corrupted it (parity
    // with the bash hook's *wiki/hot.md* match); a bare "hot.md" mention
    // elsewhere (e.g. grep -r hot.md /tmp) is not a corruption candidate.
    if (!cmd || !cmd.includes("wiki/hot.md")) return;

    const hotPath = join(vaultPath, "wiki", "hot.md");
    try {
      if (existsSync(hotPath) && statSync(hotPath).size === 0) {
        // 0-byte corruption detected - restore the last good version from git.
        let restored = false;
        try {
          // spawnSync (no shell interpolation of the config-controlled vault
          // path) resets index AND worktree via checkout HEAD --.
          const result = spawnSync("git", ["-C", vaultPath, "checkout", "HEAD", "--", "wiki/hot.md"], {
            encoding: "utf-8",
            timeout: 5000,
          });
          // HEAD itself may contain the empty blob (corruption already
          // committed) - treat that as not-restorable.
          restored = result.status === 0 && existsSync(hotPath) && statSync(hotPath).size > 0;
        } catch {
          restored = false;
        }
        if (!restored) {
          // No usable prior version - remove the empty file so the next write
          // starts fresh instead of freezing a corrupt state.
          try {
            unlinkSync(hotPath);
          } catch {
            // nothing more to do
          }
        }
        pi.sendMessage(
          {
            customType: "agents-memo-warning",
            content: restored
              ? "⚠️ agents-memo: wiki/hot.md was empty (0 bytes) - restored from git."
              : "⚠️ agents-memo: wiki/hot.md was empty (0 bytes) and no non-empty version exists in git - removed.",
            display: false,
          },
          { triggerTurn: false },
        );
      }
    } catch {
      // file may have been deleted - that's fine
    }
  });

  // ── AC14/AC15: agent_settled - auto-commit + notification ──────────────────
  pi.on("agent_settled", async (_event: AgentSettledEvent, ctx: ExtensionContext) => {
    const config = readPiSettings();
    const vaultPath = getVaultPath();
    // Auto-commit is authoritative from git status, not from the per-run
    // touched flag: agent_end (which owns that flag) fires before
    // agent_settled in the pi runtime, so gating here on vaultTouched would
    // skip auto-commit on every session.
    // Default true (only an explicit false disables) for parity with
    // log-obsidian-calls.sh's unconditional write-verb auto-commit.
    if (!vaultPath || config.autoCommit === false) return;

    try {
      const status = await pi.exec("git", ["-C", vaultPath, "status", "--porcelain"]);
      if (status.code !== 0 || status.stdout.trim().length === 0) return;
      await pi.exec("git", ["-C", vaultPath, "add", "wiki/", ".raw/"]);
      await pi.exec("git", ["-C", vaultPath, "commit", "-m", "auto: vault changes [agents-memo]"]);
      if (ctx.hasUI) {
        ctx.ui.notify("Wiki updated - changes auto-committed", "info");
      }
    } catch {
      // vault is not a git repo or git failed - skip auto-commit
    }
  });

  // ── AC16: agent_end - reflect the session into the daily note ──────────────
  pi.on("agent_end", (_event, _ctx) => {
    // Consume the per-run flag first so reflection never double-fires and the
    // next run starts clean (agent_end fires before agent_settled in the pi
    // runtime: _emitExtensionEvent → _emitAgentSettled).
    const touched = vaultTouched;
    vaultTouched = false;
    const vaultPath = getVaultPath();
    if (!vaultPath || !touched) return;
    appendDailyReflection(vaultPath, "[agents-memo] session ended - vault was modified");
  });

  // ── AC17: session_shutdown - end-of-session summary reflection ─────────────
  pi.on("session_shutdown", (_event, _ctx) => {
    const vaultPath = getVaultPath(); // for this session's reflection
    bootstrapServed = false; // next session in this process re-injects
    // Consume the session flags so a shutdown landing mid-run never leaks
    // touches into the next session's first agent_end reflection.
    const touched = sessionTouched;
    vaultTouched = false;
    sessionTouched = false;
    // Invalidate the vault cache LAST: the getVaultPath() read above
    // re-populates it, so resetting first would be undone. A reused process
    // starting in a different cwd then re-resolves on the next session.
    vaultPathCached = null;
    if (!vaultPath || !touched) return;
    appendDailyReflection(vaultPath, "[agents-memo] session shutdown - end-of-session reflection");
  });
}
