import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("returns a zero score with no indices for an empty query", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, indices: [] });
  });

  it("returns null when the query isn't a subsequence of the target", () => {
    expect(fuzzyMatch("xyz", "abc")).toBeNull();
    expect(fuzzyMatch("ba", "abc")).toBeNull(); // wrong order
  });

  it("matches a simple subsequence and returns its indices in order", () => {
    const result = fuzzyMatch("tt", "toggle theme");
    expect(result).not.toBeNull();
    expect(result!.indices).toEqual([0, 7]);
  });

  it("is case-insensitive for matching but rewards exact case", () => {
    const lower = fuzzyMatch("vt", "View: Toggle Theme");
    const exactCase = fuzzyMatch("VT", "View: Toggle Theme");
    expect(lower).not.toBeNull();
    expect(exactCase).not.toBeNull();
    expect(exactCase!.score).toBeGreaterThan(lower!.score);
  });

  it("scores consecutive matches higher than scattered ones", () => {
    const consecutive = fuzzyMatch("view", "view: toggle theme");
    const scattered = fuzzyMatch("view", "v i e w toggle");
    expect(consecutive).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(consecutive!.score).toBeGreaterThan(scattered!.score);
  });

  it("scores word-boundary matches higher than mid-word matches", () => {
    // "go" eşleşen ilk konum: "Go to file" -> kelime başı ("G", "t" boşluktan sonra).
    const wordStart = fuzzyMatch("gt", "Go to file");
    // Aynı iki harf ama kelime içinde (mid-word) eşleşecek bir hedef.
    const midWord = fuzzyMatch("gt", "xgxtx");
    expect(wordStart).not.toBeNull();
    expect(midWord).not.toBeNull();
    expect(wordStart!.score).toBeGreaterThan(midWord!.score);
  });

  it("finds the leftmost greedy match for repeated characters", () => {
    const result = fuzzyMatch("aa", "banana");
    expect(result).not.toBeNull();
    expect(result!.indices).toEqual([1, 3]);
  });
});
