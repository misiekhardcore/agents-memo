/**
 * agents-memo pi extension
 *
 * Pi port of the Claude Code hooks in hooks/hooks.json. Handles:
 *   - tool_call: rewrites ${MEMO_PLUGIN_PWD} and leading `obsidian` calls to
 *     scripts/obsidian-cli.sh, blocks daily/*.md overwrites (issue #98), and
 *     blocks direct read/write/edit on vault paths.
 *   - before_agent_start / session_compact: injects _shared/INIT.md, the
 *     hot cache / index when bootstrap config says "always", and the
 *     project+global memory digest (per-project-memory.md §9.4).
 *   - tool_execution_end: guards wiki/hot.md against silent 0-byte corruption.
 *   - agent_settled: auto-commits vault git changes and notifies.
 *   - agent_end: distills the run into project + global cores (reflection).
 *   - session_shutdown: end-of-session daily marker + cross-project
 *     promotion sweep into wiki/global-core.md (§9.6); /memo-wiki promote-global
 *     triggers the same sweep on demand.
 *
 * API surface: @earendil-works/pi-coding-agent (installed pi@0.83.0). Validated
 * with `tsc --noEmit --strict` against the installed package's dist types.
 */

import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getRuntime, resetRuntime } from "./runtime";
import type {
  AgentEndEvent,
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
import { DEFAULT_SIMILARITY_THRESHOLD, readPiSettings } from "./config";
import { getProjectSlug } from "./git-helpers";
import { appendWikiPointer, writeVaultAgentsMd } from "./agents-md";
import {
  compactCoreFile,
  pluginRoot,
  sweepPromoteGlobal,
  updateGlobalCore,
  updateProjectCore,
} from "./core-management";
import { appendDailyReflection, appendProjectDailyEntry, isDailyOverwrite } from "./daily";
import {
  execObsidianRead,
  getSessionTouched,
  getVaultPath,
  getVaultTouched,
  isObsidianRouted,
  isVaultBypassed,
  persistVaultPath,
  setSessionTouched,
  setVaultPathCached,
  setVaultPathCachedFor,
  setVaultTouched,
  vaultContainedPair,
} from "./obsidian";
import { runScript } from "./helpers";
import { buildDigest } from "./digest";
import { extractVerb } from "./language-helpers";
import { runReflection } from "./reflect";
// In-process model calls for the session reflection (agent_end). The pi
// runtime resolves this bare specifier to its bundled compat entrypoint via
// the extension-loader import map; the peer dependency only supplies types
// and the hermetic smoke-test resolution.

// ─── Settings ─────────────────────────────────────────────────────────────────

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

// ─── Write-verb detection (touched tracking) ─────────────────────────────────
// Write-verb class mirrors hooks/log-obsidian-calls.sh's auto-commit verbs
// (create, append, prepend, create-or-append, property:set, property:remove,
// eval) plus `overwrite` (a create flag; harmless to over-match).
const WRITE_VERB_RE =
  /\b(create|create-or-append|append|prepend|overwrite|property:set|property:remove|eval)\b/;

// ─── Session state ────────────────────────────────────────────────────────────

// toolCallId → bash command (tool_execution_end has no input field; the guard
// needs the command text to know whether hot.md was involved).
const bashCommands = new Map<string, string>();

// Session-scoped latch for before_agent_start handlers (INIT/hot/index).
// Moved to module scope so resetExtensionState() can reset it for test
// isolation.
let bootstrapServed = false;
// Project slug cached at before_agent_start so session_compact re-injects
// the same project's core.md even if process.cwd() changed mid-session.
let lastProjectSlug: string | undefined;
// Cwd cached at before_agent_start so session_compact can resolve the
// vault / settings against the worktree.
let lastCwd: string | undefined;

// ─── Extension state reset ────────────────────────────────────────────────────
// Exported for test isolation: vitest isolates test files, but suites within
// one file drive many sessions in a single process.
export function resetExtensionState(): void {
  initContent = null;
  bashCommands.clear();
  bootstrapServed = false;
  lastProjectSlug = undefined;
  lastCwd = undefined;
  setVaultTouched(false);
  setSessionTouched(false);
  resetRuntime(); // reset the runtime mock if it was set
}

// ─── Extension entry point ────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  // ── AC5/AC6/AC7/AC12: tool_call (rewrite + block) ──────────────────────────
  pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | void => {
    const vaultPath = getVaultPath(ctx.cwd);

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
      cmd = cmd.replace(/^([ \t]*)obsidian(\s+|$)/, `$1"${pluginRoot}/scripts/obsidian-cli.sh"$2`);

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
      const mentionsVault =
        isObsidianRouted(cmd) || (vaultPath !== null && cmd.includes(vaultPath));
      if (mentionsVault) {
        const verb = extractVerb(cmd);
        if (verb !== null && WRITE_VERB_RE.test(verb)) {
          setVaultTouched(true);
          setSessionTouched(true);
        }
      }
    }

    // AC12: block direct file I/O on vault paths (bypass allowlist applies).
    if (
      vaultPath !== null &&
      (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit")
    ) {
      const raw = event.input as { file_path?: string; path?: string };
      const filePath = String(raw.file_path ?? raw.path ?? "");
      if (filePath) {
        const pair = vaultContainedPair(filePath, vaultPath, ctx.cwd);
        if (pair) {
          // Bypass-allowlist rel path from the same realpath-normalized values
          // used by containment (parity with block-direct-vault-io.sh, which
          // realpaths both sides first), so symlinked vaults classify
          // .raw/_attachments correctly.
          const rel = pair.abs.slice(pair.vaultAbs.length + 1);
          if (!isVaultBypassed(rel, event.toolName)) {
            const verbMap: Record<string, string> = {
              read: "obsidian read path=<file>",
              write: 'obsidian create path=<file> content="..."',
              edit: 'obsidian create path=<file> overwrite=true content="..." (full content replacement)',
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
  const isSessionBootstrap = () => {
    if (bootstrapServed) return false;
    // All handlers of one emit complete within the current task; flip the
    // latch only after the emit finishes so INIT + hot + index all inject on
    // the first prompt.
    setImmediate(() => {
      bootstrapServed = true;
    });
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
  pi.on("before_agent_start", (_event, ctx): BeforeAgentStartEventResult | void => {
    if (!isSessionBootstrap()) return;
    if (readPiSettings(ctx.cwd).bootstrapReadHot !== "always") return;
    const vaultPath = getVaultPath(ctx.cwd);
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
  pi.on("before_agent_start", (_event, ctx): BeforeAgentStartEventResult | void => {
    if (!isSessionBootstrap()) return;
    if (readPiSettings(ctx.cwd).bootstrapReadIndex !== "always") return;
    const vaultPath = getVaultPath(ctx.cwd);
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

  // ── AC-PM: inject the memory digest (project + global cores) ───────────────
  // Token-lean replacement for phase-1's full project-core injection: top-N
  // learnings from both cores, truncated to digestBudgetChars (design §9.4).
  // The slug is cached so session_compact re-injects the same project's
  // digest even if process.cwd() changed mid-session (memory: never guess
  // the slug in session_compact).
  pi.on("before_agent_start", (_event, ctx): BeforeAgentStartEventResult | void => {
    if (!isSessionBootstrap()) return;
    const config = readPiSettings(ctx.cwd);
    if (config.projectMemory?.enabled === false) return;
    const vaultPath = getVaultPath(ctx.cwd);
    if (!vaultPath) return;
    // Slug and cwd cached BEFORE the sessionStart flag check: session_compact
    // re-injects whenever reInjectOnCompact alone is on, independent of
    // whether the session-start digest was injected (memory: never guess the
    // slug or cwd in session_compact — process.cwd() may have changed by then).
    const slug = getProjectSlug(ctx.cwd);
    lastProjectSlug = slug;
    lastCwd = ctx.cwd;
    if (config.memoryInjection?.sessionStart === false) return;
    const digest = buildDigest(vaultPath, slug, config);
    if (!digest) return;
    return {
      message: {
        customType: "agents-memo-memory-digest",
        content: digest,
        display: false,
      },
    };
  });

  // ── AC11: session_compact re-injects hot.md / index.md per bootstrap config ─
  // and the cached project core.md (same pattern as hot/index).
  pi.on("session_compact", (_event: SessionCompactEvent) => {
    const config = readPiSettings(lastCwd);
    const vaultPath = getVaultPath(lastCwd);
    if (!vaultPath) return;

    if (config.bootstrapReadHot === "always") {
      const hot = execObsidianRead(vaultPath, "wiki/hot.md");
      if (hot) {
        pi.sendMessage(
          {
            customType: "agents-memo-hot",
            content: `[agents-memo: wiki/hot.md]\n${hot}`,
            display: false,
          },
          { triggerTurn: false },
        );
      }
    }
    if (config.bootstrapReadIndex === "always") {
      const index = execObsidianRead(vaultPath, "wiki/index.md");
      if (index) {
        pi.sendMessage(
          {
            customType: "agents-memo-index",
            content: `[agents-memo: wiki/index.md]\n${index}`,
            display: false,
          },
          { triggerTurn: false },
        );
      }
    }
    // Digest re-injection uses the slug cached at before_agent_start, never
    // process.cwd() (which may have changed by compaction time), and only
    // when the session actually resolved a vault + slug.
    if (
      config.memoryInjection?.reInjectOnCompact !== false &&
      config.projectMemory?.enabled !== false &&
      lastProjectSlug
    ) {
      const digest = buildDigest(vaultPath, lastProjectSlug, config);
      if (digest) {
        pi.sendMessage(
          {
            customType: "agents-memo-memory-digest",
            content: digest,
            display: false,
          },
          { triggerTurn: false },
        );
      }
    }
  });

  // ── AC13: tool_execution_end - hot-cache guard (0-byte corruption) ─────────
  pi.on("tool_execution_end", (event: ToolExecutionEndEvent, ctx: ExtensionContext) => {
    const vaultPath = getVaultPath(ctx.cwd);
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
          const result = getRuntime().spawnSync(
            "git",
            ["-C", vaultPath, "checkout", "HEAD", "--", "wiki/hot.md"],
            {
              encoding: "utf-8",
              timeout: 5000,
            },
          );
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
    const config = readPiSettings(ctx.cwd);
    const vaultPath = getVaultPath(ctx.cwd);
    // Auto-commit is authoritative from git status, not from the per-run
    // touched flag: agent_end (which owns that flag) fires before
    // agent_settled in the pi runtime, so gating here on vaultTouched would
    // skip auto-commit on every session.
    // Default true (only an explicit false disables) for parity with
    // log-obsidian-calls.sh's unconditional write-verb auto-commit.
    if (!vaultPath || config.autoCommit === false) return;

    try {
      // Status gate scoped to the paths git add stages — Obsidian's own
      // .obsidian/* churn (workspace.json, types.json) would otherwise keep
      // the whole-repo gate permanently open and fire false notifications.
      const status = await pi.exec("git", [
        "-C",
        vaultPath,
        "status",
        "--porcelain",
        "--",
        "wiki/",
        ".raw/",
      ]);
      if (status.code !== 0 || status.stdout.trim().length === 0) return;
      // pi.exec resolves with {code} on failure (never throws): "nothing to
      // commit" exits 1, so gate the notify on the actual commit result and
      // exit silently otherwise — parity with log-obsidian-calls.sh's
      // `git diff --cached --quiet` gating.
      const add = await pi.exec("git", ["-C", vaultPath, "add", "wiki/", ".raw/"]);
      if (add.code !== 0) return;
      const commit = await pi.exec("git", [
        "-C",
        vaultPath,
        "commit",
        "-m",
        "auto: vault changes [agents-memo]",
      ]);
      if (commit.code !== 0) return;
      // Opt-in auto-push (issue #193 Phase 3): push the vault repo after a
      // successful auto-commit. Never force-pushes and never retries - a failed
      // push (e.g. the remote moved) leaves the commit local and notifies.
      if (config.autoPush === true) {
        const push = await pi.exec("git", ["-C", vaultPath, "push"]);
        if (push.code !== 0 && ctx.hasUI) {
          ctx.ui.notify(
            "Changes committed locally, but auto-push failed - no force-push attempted",
            "warning",
          );
        }
      }
      if (ctx.hasUI) {
        ctx.ui.notify("Wiki updated - changes auto-committed", "info");
      }
    } catch {
      // vault is not a git repo or git failed - skip auto-commit
    }
  });

  // ── AC16: agent_end - reflect the run into project memory (or legacy daily) ─
  pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
    const touched = getVaultTouched();
    setVaultTouched(false);
    const vaultPath = getVaultPath(ctx.cwd);
    if (!vaultPath) {
      ctx.ui.notify("[agents-memo] agent_end: no vault path, skipping", "warning");
      return;
    }
    const config = readPiSettings(ctx.cwd);
    if (config.projectMemory?.enabled === false) {
      // Legacy path: static global daily marker (sessions that opted out of
      // per-project pages keep the old behavior unchanged). Stays
      // touched-gated — untouched runs never write the legacy marker.
      if (touched)
        appendDailyReflection(vaultPath, "[agents-memo] session ended - vault was modified");
      return;
    }
    // Untouched runs reflect only when reflectUntouchedRuns is on (default
    // true): reflection is cheap and sessions that never wrote the vault can
    // still produce learnings worth distilling.
    if (!touched && !config.projectMemory?.reflectUntouchedRuns) {
      ctx.ui.notify("[agents-memo] agent_end: no touches, skipping", "warning");
      return;
    }

    const slug = getProjectSlug(ctx.cwd);
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5);
    const messages = event.messages ?? [];
    if (messages.length === 0) {
      ctx.ui.notify("[agents-memo] agent_end: no messages, skipping", "warning");
      return;
    }
    // In-process complete() wrapped in withTimeout — never blocks the session
    // event loop and strictly bounded (a hung model call resolves null after
    // REFLECTION_MODEL_TIMEOUT_MS instead of freezing the session).
    // Working indicator during the learning pipeline (parity with
    // pi-self-learning's "learning" status); cleared in finally so a timed-out
    // reflection can never leave a stale indicator.
    if (ctx.hasUI) {
      try {
        ctx.ui.setWorkingMessage("learning");
      } catch (err) {
        const errStr = String(err);
        ctx.ui.notify(
          `[agents-memo] agent_end: failed to set UI working message: ${errStr}`,
          "error",
        );
      }
    }
    try {
      const reflection = await runReflection(config, ctx, messages.slice(-8));
      if (!reflection) {
        ctx.ui.notify("[agents-memo] agent_end: no reflection generated", "warning");
        return;
      }
      ctx.ui.notify(
        `[agents-memo] agent_end: reflection generated with ${reflection.mistakes.length} mistakes, ${reflection.fixes.length} fixes`,
      );
      appendProjectDailyEntry(vaultPath, slug, dateStr, timeStr, reflection);
      updateProjectCore(vaultPath, slug, dateStr, reflection, config.projectMemory?.maxCoreItems);
      // Global bucket: cross-project learnings land in wiki/global-core.md
      // (skipped when the global store is disabled; empty-bucket reflections
      // are a no-op merge over whatever the store already holds).
      if (config.projectMemory?.globalEnabled !== false) {
        updateGlobalCore(
          vaultPath,
          dateStr,
          reflection,
          config.projectMemory?.maxGlobalItems,
          config.pageCandidacy?.threshold,
        );
      }
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes("ERR_STREAM_DESTROYED") || errStr.includes("stream was destroyed")) {
        ctx.ui.notify(
          `[agents-memo] agent_end: ERR_STREAM_DESTROYED - stream cleanup issue during reflection`,
          "error",
        );
      } else {
        ctx.ui.notify(`[agents-memo] agent_end error: ${errStr}`, "error");
      }
    } finally {
      if (ctx.hasUI) {
        try {
          ctx.ui.setWorkingMessage();
        } catch (err) {
          const errStr = String(err);
          ctx.ui.notify(
            `[agents-memo] agent_end: failed to clear UI working message: ${errStr}`,
            "error",
          );
        }
      }
    }
  });

  // ── AC-PM: promotion sweep command (/memo-wiki promote-global) ────────────
  // Deterministic cross-project promotion (§9.6): entries present in
  // >= promotionThreshold project cores move into wiki/global-core.md with a
  // provenance marker. On-demand counterpart of the session_shutdown trigger.
  pi.registerCommand("memo:promote-global", {
    description:
      "Promote cross-project learnings into wiki/global-core.md (deterministic sweep, no LLM)",
    handler: async (_args, ctx) => {
      const vaultPath = getVaultPath(ctx.cwd);
      const config = readPiSettings(ctx.cwd);
      if (!vaultPath) {
        if (ctx.hasUI) ctx.ui.notify("agents-memo: no vault resolved — cannot sweep", "error");
        return;
      }
      if (config.projectMemory?.globalEnabled === false) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "agents-memo: global memory is disabled (projectMemory.globalEnabled=false)",
            "error",
          );
        return;
      }
      const result = sweepPromoteGlobal(
        vaultPath,
        config.projectMemory?.promotionThreshold,
        config.projectMemory?.maxGlobalItems,
      );
      if (ctx.hasUI) {
        ctx.ui.notify(
          result.promoted > 0
            ? `agents-memo: promoted ${result.promoted} cross-project learning(s) into wiki/global-core.md`
            : "agents-memo: nothing to promote (no entry appears in enough project cores)",
          "info",
        );
      }
    },
  });

  // ── /memo-wiki compact-core ──────────────────────────────────────────────
  // Merge near-duplicate bullets in the project core whose raw text has
  // Jaccard bigram similarity >= similarityThreshold. On-demand compact,
  // replay-safe: a second run with the same config is a no-op.
  pi.registerCommand("memo:compact-core", {
    description: "Merge near-duplicate entries in the project core (Jaccard bigram similarity)",
    handler: async (_args, ctx) => {
      const vaultPath = getVaultPath(ctx.cwd);
      const config = readPiSettings(ctx.cwd);
      if (!vaultPath) {
        if (ctx.hasUI) ctx.ui.notify("agents-memo: no vault resolved — cannot compact", "error");
        return;
      }
      if (config.projectMemory?.enabled === false) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "agents-memo: project memory is disabled (projectMemory.enabled=false)",
            "error",
          );
        return;
      }
      const slug = getProjectSlug(ctx.cwd);
      const threshold = config.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
      const result = compactCoreFile(vaultPath, slug, threshold);
      if (ctx.hasUI) {
        ctx.ui.notify(
          result === null
            ? "agents-memo: compact failed (core.md read error)"
            : result > 0
              ? `agents-memo: compacted ${result} near-duplicate pair(s) in wiki/projects/${slug}/core.md`
              : `agents-memo: nothing to compact in wiki/projects/${slug}/core.md`,
          result === null ? "error" : "info",
        );
      }
    },
  });

  // ── /memo:init — vault initialization command ──────────────────────────────
  // Single-token slash-dispatchable counterpart of the init flow that used to
  // live in the /memo-wiki skill. Bootstraps the vault (wiki-init.sh), git-inits
  // it, writes the vault AGENTS.md (pi reads it when CWD is the vault), and
  // offers optional extras: the weekly lint timer and a Wiki Knowledge Base
  // pointer in the CWD project's AGENTS.md.
  pi.registerCommand("memo:init", {
    description:
      "Initialize an Obsidian vault for agents-memo: bootstrap, git init, vault AGENTS.md, optional lint timer + project pointer",
    handler: async (_args, ctx) => {
      const ui = ctx.hasUI ? ctx.ui : null;
      let vaultPath = getVaultPath(ctx.cwd);
      if (!vaultPath) {
        const input = ui
          ? await ui.input(
              "agents-memo: no vault configured. Enter the vault path (absolute):",
              "~/path/to/vault",
            )
          : undefined;
        if (!input) {
          ui?.notify("agents-memo: init cancelled (no vault path provided)", "info");
          return;
        }
        vaultPath = input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
        if (!existsSync(vaultPath)) {
          ui?.notify(`agents-memo: vault path does not exist: ${vaultPath}`, "error");
          return;
        }
        if (persistVaultPath(vaultPath, ctx)) {
          // Invalidate the per-cwd cache so later getVaultPath() calls re-resolve
          // against the freshly written settings file.
          setVaultPathCached(null);
          setVaultPathCachedFor(undefined);
          ui?.notify(
            `agents-memo: vault path saved to ~/.pi/agent/settings.json (${vaultPath})`,
            "info",
          );
        } else {
          ui?.notify(
            "agents-memo: could not persist vaultPath — configure agentsMemo.vaultPath in ~/.pi/agent/settings.json manually",
            "warning",
          );
        }
      }
      if (ui) {
        const ok = await ui.confirm("agents-memo: init", `Initialize vault at ${vaultPath}?`);
        if (!ok) {
          ui.notify("agents-memo: init cancelled", "info");
          return;
        }
      }
      // 1. Bootstrap: setup-vault + copy-templates + seed-demo (idempotent)
      ui?.setWorkingMessage("agents-memo: bootstrapping vault…");
      let bootstrapOut: string;
      try {
        bootstrapOut = runScript(join(pluginRoot, "bin", "wiki-init.sh"), [vaultPath]);
      } catch (err) {
        ui?.setWorkingMessage();
        ui?.notify(
          `agents-memo: bootstrap failed — ${err instanceof Error ? err.message : "unknown error"}`,
          "error",
        );
        return;
      }
      // 2. git init (best-effort — a vault without git still works)
      if (!existsSync(join(vaultPath, ".git"))) {
        try {
          getRuntime().exec("git init", { cwd: vaultPath, encoding: "utf-8" });
        } catch {
          // best-effort
        }
      }
      // 3. Vault AGENTS.md (self-contained conventions; pi discovers it from the vault)
      writeVaultAgentsMd(vaultPath);
      // 4. Optional: weekly lint timer (systemd user timer)
      if (ui) {
        const installCron = await ui.confirm(
          "agents-memo: init",
          "Install the weekly lint timer (systemd, Sun 03:00, bin/install-lint-service.sh)?",
        );
        if (installCron) {
          try {
            runScript(join(pluginRoot, "bin", "install-lint-service.sh"), []);
          } catch (err) {
            ui.notify(
              `agents-memo: cron install failed — ${err instanceof Error ? err.message : "unknown error"}`,
              "error",
            );
          }
        }
      }
      // 5. Optional: point the CWD project at the vault (consumer project != vault)
      const cwd = ctx.cwd;
      if (ui && cwd) {
        const cwdAbs = resolve(cwd);
        if (cwdAbs !== vaultPath && !cwdAbs.startsWith(`${vaultPath}/`)) {
          const pointer = await ui.confirm(
            "agents-memo: init",
            `Point this project (${basename(cwd)}) at the vault? Adds a Wiki Knowledge Base block to ${cwdAbs}/AGENTS.md.`,
          );
          if (pointer) appendWikiPointer(cwd, vaultPath);
        }
      }
      ui?.setWorkingMessage();
      const tail = bootstrapOut.split("\n").slice(-12).join("\n");
      ui?.notify(`agents-memo: vault initialized at ${vaultPath}\n${tail}`, "info");
    },
  });

  // ── AC17: session_shutdown - end-of-session summary reflection ─────────────
  pi.on("session_shutdown", (_event, _ctx) => {
    const vaultPath = getVaultPath(); // for this session's reflection
    // Capture the session's cwd before resetting — auto-compact below needs
    // it for slug derivation, and process.cwd() may have changed by shutdown.
    const shutdownCwd = lastCwd;
    bootstrapServed = false; // next session in this process re-injects
    lastProjectSlug = undefined; // stale slug must not leak into the next session
    lastCwd = undefined;
    // Promotion sweep (§9.6): cross-project repeats land in the global core
    // at session end (gated on global memory being enabled). The vaultPath
    // read above guards reload churn — without a vault resolved this session
    // nothing is swept, and an empty store keeps the sweep a no-op.
    const config = readPiSettings();
    if (vaultPath && config.projectMemory?.globalEnabled !== false) {
      sweepPromoteGlobal(
        vaultPath,
        config.projectMemory?.promotionThreshold,
        config.projectMemory?.maxGlobalItems,
      );
    }
    // Auto-compact: merge near-duplicate bullets in the session's project
    // core when the number of pairs at/above autoCompactThreshold exceeds 0.
    // Wrapped in try/catch so a compact failure never blocks shutdown.
    if (vaultPath && config.projectMemory?.enabled !== false) {
      try {
        const slug = getProjectSlug(shutdownCwd ?? process.cwd());
        compactCoreFile(vaultPath, slug, config.autoCompactThreshold);
      } catch {
        // best-effort — never fail the shutdown
      }
    }
    // Consume the session flags so a shutdown landing mid-run never leaks
    // touches into the next session's first agent_end reflection.
    const touched = getSessionTouched();
    setVaultTouched(false);
    setSessionTouched(false);
    // Invalidate the vault cache LAST: the getVaultPath() read above
    // re-populates it, so resetting first would be undone. A reused process
    // starting in a different cwd then re-resolves on the next session.
    setVaultPathCached(null);
    setVaultPathCachedFor(undefined);
    if (!vaultPath || !touched) return;
    appendDailyReflection(vaultPath, "[agents-memo] session shutdown - end-of-session reflection");
  });
}
