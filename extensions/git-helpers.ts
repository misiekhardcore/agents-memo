import { basename } from "path";
import { sanitizeSlug } from "./language-helpers";
import { getRuntime } from "./runtime";

// Exported for the smoke test.
export function getProjectSlug(cwd: string): string {
  try {
    const url = getRuntime()
      .exec("git remote get-url origin", {
        cwd,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();
    // "git@github.com:owner/repo.git" or "https://github.com/owner/repo" → owner/repo
    const match = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) return sanitizeSlug(match[1].split("/")[1]);
  } catch {
    // no git remote - fall through to directory name
  }
  return sanitizeSlug(basename(cwd));
}
