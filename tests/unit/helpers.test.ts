import { describe, expect, it } from "vitest";
import {
  escapeShellContent,
  expandTilde,
  normalizeKey,
  stripEnvPrefix,
  withTimeout,
} from "../../extensions/helpers";
import { extractVerb, sanitizeSlug } from "../../extensions/language-helpers";
import { isDailyOverwrite } from "../../extensions/daily";

describe("normalizeKey", () => {
  it("stems, drops stopwords, maps synonyms and strips markers", () => {
    // "Keep edits small" and "keep  edits   small" normalize identically.
    expect(normalizeKey("Keep Edits Small")).toBe(normalizeKey("keep  edits   small"));
  });

  it("strips wikilinks, candidate and provenance markers", () => {
    const a = normalizeKey("Prefer small diffs [[review-process]]<!--candidate-->");
    const b = normalizeKey("Prefer small diffs");
    expect(a).toBe(b);
  });

  it("falls back to lowercased raw text when every token is a stopword", () => {
    expect(normalizeKey("the and of")).toBe("the and of");
  });
});

describe("escapeShellContent", () => {
  it("escapes $ and backticks so command substitution cannot execute", () => {
    const out = escapeShellContent("use $(echo PWNED) and `whoami`");
    expect(out).toContain("\\$(echo PWNED)");
    expect(out).toContain("\\`whoami\\`");
    expect(out).not.toMatch(/(^|[^\\])\$\(/);
    expect(out).not.toMatch(/(^|[^\\])`/);
  });

  it("escapes quotes and converts real newlines to literal \\n", () => {
    expect(escapeShellContent('a "b" c')).toBe('a \\"b\\" c');
    expect(escapeShellContent("line1\nline2")).toBe("line1\\nline2");
  });
});

describe("withTimeout", () => {
  it("rejects a never-resolving promise at the bound", async () => {
    const never = new Promise(() => {});
    const started = Date.now();
    await expect(withTimeout(never, 50, "never-resolving test promise")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("passes through a resolving promise", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50, "resolving")).resolves.toBe("ok");
  });

  it("aborts the controller on timeout", async () => {
    const controller = new AbortController();
    let aborted = false;
    controller.signal.addEventListener("abort", () => {
      aborted = true;
    });
    await expect(withTimeout(new Promise(() => {}), 20, "abort", controller)).rejects.toThrow();
    expect(aborted).toBe(true);
  });
});

describe("extractVerb", () => {
  it("extracts positionally from routed commands (last wrapper wins)", () => {
    expect(extractVerb('"x/obsidian-cli.sh" read path=wiki/hot.md')).toBe("read");
    expect(
      extractVerb('"x/obsidian-cli.sh" read p && "x/obsidian-cli.sh" append file=y'),
    ).toBe("append");
    // `read | grep append` must not look like a write.
    expect(extractVerb('"x/obsidian-cli.sh" read p | grep append')).toBe("read");
  });

  it("handles raw obsidian commands and env prefixes", () => {
    expect(extractVerb("obsidian append file=wiki/hot.md")).toBe("append");
    expect(extractVerb("FOO=bar obsidian append file=wiki/hot.md")).toBe("append");
    expect(extractVerb("ls -la")).toBeNull();
  });
});

describe("stripEnvPrefix", () => {
  it("skips leading KEY=val assignments", () => {
    expect(stripEnvPrefix(["FOO=bar", "BAZ=1", "obsidian", "read"])).toBe(2);
    expect(stripEnvPrefix(["obsidian", "read"])).toBe(0);
  });
});

describe("sanitizeSlug", () => {
  it("lowercases and collapses non-alphanumerics to hyphens", () => {
    expect(sanitizeSlug("My_Repo")).toBe("my-repo");
    expect(sanitizeSlug("My Dir")).toBe("my-dir");
    expect(sanitizeSlug("My.Dir_1")).toBe("my-dir-1");
    expect(sanitizeSlug("")).toBe("unknown");
  });
});

describe("expandTilde", () => {
  it("expands ~ and ~/ prefixes", () => {
    const home = process.env.HOME;
    expect(expandTilde("~")).toBe(home);
    expect(expandTilde("~/x")).toBe(`${home}/x`);
    expect(expandTilde("/abs")).toBe("/abs");
  });
});

describe("isDailyOverwrite", () => {
  it("blocks create overwrite=true on daily paths only", () => {
    expect(
      isDailyOverwrite('obsidian create path=daily/2026-08-06.md overwrite=true content="x"'),
    ).toBe(true);
    expect(
      isDailyOverwrite("obsidian create-or-append file=daily/2026-08-06.md content=x"),
    ).toBe(false);
    expect(
      isDailyOverwrite('"x/obsidian-cli.sh" create path=daily/x.md overwrite=true content=x'),
    ).toBe(false);
  });
});
