import { join, resolve } from "path";
import { pluginRoot } from "./core-management";
import { getRuntime } from "./runtime";
import { readClaudeVaultPath, readPiSettings } from "./config";
import { closeSync, existsSync, openSync, readFileSync, statSync, writeSync } from "fs";
import { expandTilde, realpathOrResolve, stripEnvPrefix } from "./helpers";
import { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "os";

interface ObsidianReadResult {
  ok: boolean;
  content: string;
}

// Safe core read: distinguishes "file missing" from "read failed" so write
// pipelines never mistake a transient CLI failure for an empty file. The
// obsidian-cli.sh wrapper normalizes the upstream CLI's always-zero exit to
// exit 1 with `Error: File "<path>" not found.` on stdout when the target
// file is missing; that specific shape is a normal cold-start condition and
// reports as ok with empty content. Any other failure (preflight, vault
// resolution, generic CLI error) reports as not-ok and callers skip the
// write. Exported for the smoke test (pi only invokes the default export).
export function execObsidianReadSafe(vaultPath: string, relPath: string): ObsidianReadResult {
  try {
    const obsCli = join(pluginRoot, "scripts", "obsidian-cli.sh");
    const content = getRuntime().exec(`bash "${obsCli}" read "path=${relPath}"`, {
      cwd: vaultPath,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, content };
  } catch (err) {
    const out = String((err as { stdout?: unknown })?.stdout ?? "");
    if (/Error: File .* not found/.test(out)) return { ok: true, content: "" };
    return { ok: false, content: "" };
  }
}

export function execObsidianRead(vaultPath: string, relPath: string): string | null {
  const result = execObsidianReadSafe(vaultPath, relPath);
  return result.ok ? result.content : null;
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

export function isVaultBypassed(vaultRelativePath: string, toolName: string): boolean {
  for (const entry of VAULT_IO_BYPASS) {
    if (entry.pattern.test(vaultRelativePath)) {
      return entry.tools.includes(toolName.toLowerCase());
    }
  }
  return false;
}
let vaultPathCached: string | null = null;
let vaultPathCachedFor: string | undefined;
let vaultTouched = false; // vault touched during the current agent run
let sessionTouched = false; // vault touched at any point this session

export function setVaultTouched(v: boolean): void {
  vaultTouched = v;
}

export function getVaultTouched(): boolean {
  return vaultTouched;
}

export function setVaultPathCachedFor(v: string | undefined): void {
  vaultPathCachedFor = v;
}

export function getVaultPathCachedFor(): string | undefined {
  return vaultPathCachedFor;
}

export function setSessionTouched(v: boolean): void {
  sessionTouched = v;
}

export function getSessionTouched(): boolean {
  return sessionTouched;
}

export function setVaultPathCached(v: string | null): void {
  vaultPathCached = v;
}

// Reset the per-session cache/touched flags. Exported for tests: vitest isolates
// test files, but suites within one file drive many sessions in a single process.
export function resetObsidianState(): void {
  vaultPathCached = null;
  vaultPathCachedFor = undefined;
  vaultTouched = false;
  sessionTouched = false;
}

export function getVaultPath(cwd?: string): string | null {
  const key = cwd ?? process.cwd();
  if (vaultPathCached !== null && vaultPathCachedFor === key) {
    return vaultPathCached;
  }
  vaultPathCached = resolveVaultPath(key);
  vaultPathCachedFor = key;
  return vaultPathCached;
}

// True when the command routes through obsidian — via the rewritten wrapper
// path, or as a raw command with a leading `obsidian` token after stripping
// leading KEY=val assignments (log-obsidian-calls.sh's CMD_NOENV gate).
export function isObsidianRouted(cmd: string): boolean {
  if (cmd.includes("obsidian-cli.sh")) return true;
  const tokens = cmd.split(/\s+/);
  return tokens[stripEnvPrefix(tokens)] === "obsidian";
}

// Exported for the smoke test (pi only invokes the default export).
export function resolveVaultPath(cwd?: string): string | null {
  const config = readPiSettings(cwd);
  if (config.vaultPath) {
    const expanded = expandTilde(config.vaultPath);
    if (existsSync(expanded) && statSync(expanded).isDirectory()) {
      return expanded;
    }
  }
  // Fallback: CWD contains a wiki/ subdirectory (resolve-vault.sh tier 2).
  // When called without an explicit cwd, only check Claude settings - don't
  // fall back to process.cwd() which could incorrectly match the current repo.
  if (cwd === undefined) {
    return readClaudeVaultPath();
  }
  const dir = cwd;
  const cwdWiki = join(dir, "wiki");
  if (existsSync(cwdWiki) && statSync(cwdWiki).isDirectory()) {
    return dir;
  }
  // Fallback: Claude Code settings (resolve-vault.sh tiers 3/4) — already
  // validated (exists + directory) inside readClaudeVaultPath.
  return readClaudeVaultPath();
}

// Normalized containment check: returns the realpath-normalized (file, vault)
// pair when filePath is inside vaultPath, or null. Separator boundary so
// /home/u/wiki does not match /home/u/wiki2 (parity with `realpath -ms` +
// prefix check in the bash hook). The vault root itself is allowed through,
// matching block-direct-vault-io.sh whose `"$VAULT"/*` literal-prefix checks
// never match the root. One realpath walk per side serves both the block
// decision and the bypass-allowlist rel path.
export function vaultContainedPair(
  filePath: string,
  vaultPath: string,
  resolveFrom?: string,
): { abs: string; vaultAbs: string } | null {
  const abs = realpathOrResolve(resolve(resolveFrom ?? process.cwd(), filePath));
  const vaultAbs = realpathOrResolve(resolve(vaultPath));
  const prefix = vaultAbs.endsWith("/") ? vaultAbs : vaultAbs + "/";
  return abs.startsWith(prefix) ? { abs, vaultAbs } : null;
}

export function persistVaultPath(vaultPath: string, ctx: ExtensionCommandContext): boolean {
  const file = join(homedir(), ".pi", "agent", "settings.json");
  try {
    let parsed: Record<string, unknown> = {};
    if (existsSync(file)) {
      parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    }
    const agentsMemo = (parsed.agentsMemo as Record<string, unknown>) ?? {};
    agentsMemo.vaultPath = vaultPath;
    parsed.agentsMemo = agentsMemo;

    // Phase 1: Safe write with explicit stream handling to prevent ERR_STREAM_DESTROYED
    let fd: number | null = null;
    try {
      fd = openSync(file, "w");
      writeSync(fd, `${JSON.stringify(parsed, null, 2)}\n`);
      closeSync(fd);
      return true;
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes("ERR_STREAM_DESTROYED") || errStr.includes("stream was destroyed")) {
        ctx.ui.notify(
          "[agents-memo] persistVaultPath: ERR_STREAM_DESTROYED detected - stream cleanup issue",
          "error",
        );
      } else {
        ctx.ui.notify(`[agents-memo] persistVaultPath write error: ${errStr}`, "error");
      }
      return false;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch (e) {
          const eStr = String(e);
          if (!eStr.includes("ERR_STREAM_DESTROYED")) {
            ctx.ui.notify(`[agents-memo] persistVaultPath: close error: ${eStr}`, "error");
          }
        }
      }
    }
  } catch (err) {
    const errStr = String(err);
    if (errStr.includes("ERR_STREAM_DESTROYED") || errStr.includes("stream was destroyed")) {
      ctx.ui.notify(
        "[agents-memo] persistVaultPath: ERR_STREAM_DESTROYED - file descriptor invalid",
        "error",
      );
    } else {
      ctx.ui.notify(`[agents-memo] persistVaultPath failed: ${errStr}`, "error");
    }
    return false;
  }
}
