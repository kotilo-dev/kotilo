import { describe, expect, it } from "vitest";
import { countPastedLines, shouldWarnMultilinePaste } from "./pasteWarning";

describe("shouldWarnMultilinePaste", () => {
  it("warns for multi-line text when bracketed paste is off and the setting is on", () => {
    expect(shouldWarnMultilinePaste("a\nb", false, true)).toBe(true);
    expect(shouldWarnMultilinePaste("a\r\nb", false, true)).toBe(true);
    expect(shouldWarnMultilinePaste("a\rb", false, true)).toBe(true);
  });

  it("does not warn for single-line text", () => {
    expect(shouldWarnMultilinePaste("just one line", false, true)).toBe(false);
  });

  it("does not warn when bracketed paste mode is on (TUI programs like claude/codex)", () => {
    expect(shouldWarnMultilinePaste("a\nb", true, true)).toBe(false);
  });

  it("does not warn when the setting is off", () => {
    expect(shouldWarnMultilinePaste("a\nb", false, false)).toBe(false);
  });
});

describe("countPastedLines", () => {
  it("counts lines separated by any EOL style", () => {
    expect(countPastedLines("a\nb\nc")).toBe(3);
    expect(countPastedLines("a\r\nb")).toBe(2);
  });

  it("counts a single line as 1", () => {
    expect(countPastedLines("only one line")).toBe(1);
  });
});
