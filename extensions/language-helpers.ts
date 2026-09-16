// ---- Porter stemmer helpers (steps 1a-1c) ----

import { stripEnvPrefix } from "./helpers";

export function isVowel(c: string): boolean {
  return "aeiou".includes(c);
}

export function isConsonantAt(word: string, i: number): boolean {
  if (isVowel(word[i])) return false;
  if (word[i] === "y") return i === 0 ? true : !isVowel(word[i - 1]);
  return true;
}

// measure() = count of vowel-consonant sequences (VC)
export function measure(word: string): number {
  let n = 0;
  let i = 0;
  while (i < word.length) {
    // skip consonants
    while (i < word.length && isConsonantAt(word, i)) i++;
    if (i === word.length) break;
    // skip vowels
    while (i < word.length && !isConsonantAt(word, i)) i++;
    n++;
  }
  return n;
}

export function containsVowel(word: string): boolean {
  for (let i = 0; i < word.length; i++) {
    if (!isConsonantAt(word, i)) return true;
  }
  return false;
}

export function endsWithCvc(word: string): boolean {
  if (word.length < 3) return false;
  const last = word[word.length - 1];
  if ("wxy".includes(last)) return false;
  const i = word.length - 1;
  return isConsonantAt(word, i - 2) && !isConsonantAt(word, i - 1) && isConsonantAt(word, i);
}

// ─── Project slug ─────────────────────────────────────────────────────────────
// Slug derived from the git origin repo name, falling back to the sanitized
// basename of the working directory. Lowercase; every non-alphanumeric run
// (spaces, underscores, dots, ...) collapses to a single hyphen; edge hyphens
// trimmed; never empty ("unknown").
export function sanitizeSlug(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

// Extract the obsidian verb positionally, mirroring log-obsidian-calls.sh's
// VERB extraction: for routed commands the first token AFTER the LAST wrapper
// occurrence that has a follower (bash's greedy `s/.*obsidian-cli\.sh
// [^[:space:]]* //` backtracks past a trailing wrapper with no verb); for raw
// commands, strip leading KEY=val assignments (bash sed #2) and take the
// token after a leading `obsidian`. This keeps `obsidian read ... | grep
// append` from counting as a write while compound commands (read && append)
// still detect the last write verb.
export function extractVerb(cmd: string): string | null {
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
  const idx = stripEnvPrefix(tokens);
  if (tokens[idx] === "obsidian") return tokens[idx + 1] ?? null;
  return null;
}
