import { homedir } from "os";
import { containsVowel, endsWithCvc, measure } from "./language-helpers";
import { basename, dirname, join, resolve } from "path";
import { realpathSync } from "fs";
import { getRuntime } from "./runtime";

export const FROM_MARKER_RE = /<!--from:[^>]*-->/g; // strip (normalizeKey)
export const WIKILINK_RE = /\[\[[^\]]*\]\]/g;
export const SCORE_MARKER_RE = /<!--score:(\d+)-->\s*$/;
export const CANDIDATE_MARKER_RE = /<!--candidate-->/g;
export const FROM_EXTRACT_RE = /<!--from:([^>]*)-->\s*/; // capture (parseCoreFile)
export const SYNONYM_MAP: Record<string, string> = {
  // Contractions and common variants collapse to a canonical form
  "don't": "dont",
  "doesn't": "doesnt",
  "won't": "wont",
  "can't": "cant",
  "isn't": "isnt",
  "aren't": "arent",
  "wasn't": "wasnt",
  "weren't": "werent",
  "haven't": "havent",
  "hasn't": "hasnt",
  "hadn't": "hadnt",
  "couldn't": "couldnt",
  "shouldn't": "shouldnt",
  "wouldn't": "wouldnt",
  "didn't": "didnt",
  "it's": "its",
  "that's": "thats",
  "there's": "theres",
  "here's": "heres",
  "what's": "whats",
  "who's": "whos",
  "let's": "lets",
  "i'm": "im",
  "you're": "youre",
  "we're": "we",
  "they're": "theyre",
  "i've": "ive",
  "you've": "youve",
  "we've": "weve",
  "they've": "theyve",
};
export const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "as",
  "is",
  "was",
  "are",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "shall",
  "can",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "we",
  "they",
  "he",
  "she",
  "i",
  "you",
  "my",
  "your",
  "our",
  "their",
  "his",
  "her",
  "me",
  "him",
  "us",
  "them",
  "not",
  "no",
  "nor",
  "so",
  "if",
  "then",
  "than",
  "too",
  "very",
  "just",
  "about",
  "also",
  "into",
  "only",
  "other",
  "some",
  "such",
  "each",
  "both",
  "all",
  "any",
  "more",
  "most",
  "now",
]);

// 7-step normalized dedup key pipeline:
//   1. lowercase
//   2. strip wikilinks and provenance markers
//   3. collapse whitespace and tokenize
//   4. map synonyms to canonical forms
//   5. remove stopwords
//   6. stem each token (Porter 1a-1c)
//   7. rejoin into normalized key
// A bullet that reduces to empty falls back to raw lowercased text so
// distinct pointers never collide on an empty key.
export function normalizeKey(text: string): string {
  // Step 1: lowercase
  let s = text.toLowerCase();

  // Step 2: strip wikilinks and provenance markers
  s = s.replace(WIKILINK_RE, "").replace(CANDIDATE_MARKER_RE, "").replace(FROM_MARKER_RE, "");

  // Step 3: collapse whitespace and tokenize
  s = s.replace(/\s+/g, " ").trim();
  const tokens = s.split(/\s+/).filter(Boolean);

  // Steps 4-6: synonym map → stopword removal → stemming
  const processed = tokens
    .map((t) => SYNONYM_MAP[t] ?? t) // Step 4: canonical synonym
    .filter((t) => !STOPWORDS.has(t)) // Step 5: drop stopwords
    .map((t) => stem(t)); // Step 6: Porter stem

  // Step 7: rejoin
  const key = processed.join(" ").trim();
  return key || text.toLowerCase().replace(/\s+/g, " ").trim();
}

function stem(word: string): string {
  if (word.length <= 2) return word;

  // Step 1a
  if (word.endsWith("sses")) {
    word = word.slice(0, -2);
  } else if (word.endsWith("ies")) {
    word = word.slice(0, -2);
  } else if (word.endsWith("ss")) {
    // keep as-is
  } else if (word.endsWith("s")) {
    word = word.slice(0, -1);
  }

  // Step 1b
  if (word.endsWith("eed")) {
    const stemPart = word.slice(0, -3);
    if (measure(stemPart) > 0) word = stemPart + "ee";
  } else {
    let found = false;
    if (word.endsWith("ed")) {
      const stemPart = word.slice(0, -2);
      if (containsVowel(stemPart)) {
        word = stemPart;
        found = true;
      }
    }
    if (!found && word.endsWith("ing")) {
      const stemPart = word.slice(0, -3);
      if (containsVowel(stemPart)) {
        word = stemPart;
        found = true;
      }
    }
    if (found) word = step1bRecode(word);
  }

  // Step 1c
  if (word.endsWith("y") && containsVowel(word.slice(0, -1))) {
    word = word.slice(0, -1) + "i";
  }

  return word;
}

function step1bRecode(word: string): string {
  // recode after removing -ed or -ing
  if (/(at|bl|iz)$/.test(word)) return word + "e";
  // double consonant at end → single
  const len = word.length;
  if (len >= 2 && word[len - 1] === word[len - 2] && !"lsz".includes(word[len - 1])) {
    word = word.slice(0, -1);
  }
  // (m=1 and *o) → add e
  if (measure(word) === 1 && endsWithCvc(word)) word += "e";
  return word;
}

// Per-key validators for each nested block (type-gated merge). Declared as
// typed constants so the merge helper infers T from the merged argument,
// keeping the value types intact.
export type NestedKeyValidator = (v: unknown) => boolean;

export const isBoolean: NestedKeyValidator = (v): v is boolean => typeof v === "boolean";
// Numeric keys are counts/budgets/thresholds: NaN, ±Infinity (JSON.parse
// accepts 1e999 → Infinity) and negatives would silently degrade digest
// budgets, caps and thresholds, so they are rejected and fall back to
// defaults instead of being honored.
export const isCount: NestedKeyValidator = (v): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;
export const isString: NestedKeyValidator = (v): v is string => typeof v === "string";

// Escape a string for a double-quoted shell argument whose value round-trips
// through the obsidian CLI content= handling: literal \n sequences become
// newlines in the vault file. Real newlines are converted to \n so multi-line
// content survives as a single shell argument.
export function escapeShellContent(text: string): string {
  return (
    text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      // $ and backticks are live in double-quoted shell args (command
      // substitution): model-generated reflection text must never reach the
      // shell unescaped (verified: $(echo PWNED) executes without these).
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`")
      .replace(/\r?\n/g, "\\n")
  );
}

export function expandTilde(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

// The created date is extracted from the existing file before a merge so a
// re-render never stamps over it. Missing/absent frontmatter → undefined,
// and the caller falls back to today.
export function extractCreatedDate(content: string): string | undefined {
  const m = content.match(/^created:\s*(\S+)/m);
  return m?.[1];
}

// Bounded race: rejects after ms (aborting the controller, if given) so a
// hung model call can never block the session. Exported for the smoke test.
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  controller?: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller?.abort();
          reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Realpath both sides with a fallback for missing paths. Parity with the bash
// hook's `realpath -ms` (symlinks preserved, existence not required): walk up
// to the longest existing ancestor, realpath it, and re-append the unresolved
// tail, so a NEW-file write inside a symlinked vault still hits containment
// instead of escaping via the un-resolved symlink prefix.
export function realpathOrResolve(p: string): string {
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

export function runScript(script: string, args: string[]): string {
  const quoted = args.map((a) => `"${a.replaceAll('"', '\\"')}"`).join(" ");
  return getRuntime().exec(`bash "${script}" ${quoted}`, {
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

// Index of the first non-env-prefix token (strips leading KEY=val
// assignments, mirroring log-obsidian-calls.sh's CMD_NOENV stripping). Shared
// by extractVerb and isObsidianRouted so the two never diverge.
export function stripEnvPrefix(tokens: string[]): number {
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++;
  return idx;
}
