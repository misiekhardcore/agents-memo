import { describe, expect, it } from "vitest";
import { bigrams, jaccard } from "../../extensions/jaccard";

describe("bigrams", () => {
  it("includes edge bigrams with space padding", () => {
    const bs = bigrams("cat");
    expect(bs.has(" c")).toBe(true);
    expect(bs.has("ca")).toBe(true);
    expect(bs.has("at")).toBe(true);
    expect(bs.has("t ")).toBe(true);
    expect(bs.size).toBe(4);
  });
});

describe("jaccard", () => {
  it("returns sensible similarity for near-identical strings", () => {
    const sim = jaccard("cat", "cats");
    expect(sim).toBeGreaterThanOrEqual(0.3);
    expect(sim).toBeLessThanOrEqual(0.9);
  });

  it("handles identity, dissimilarity and empties", () => {
    expect(jaccard("cat", "cat")).toBe(1);
    expect(jaccard("cat", "dog")).toBeLessThan(0.3);
    expect(jaccard("", "")).toBe(1);
    expect(jaccard("a", "")).toBe(0);
  });
});
