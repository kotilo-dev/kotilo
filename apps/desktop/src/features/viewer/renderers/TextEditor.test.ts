import { describe, expect, it } from "vitest";
import { languageForRel, modelPathFor, monacoThemeFor } from "./textEditorSupport";

describe("monacoThemeFor (faz6-spec §10.8)", () => {
  it("maps 'dark' to the custom 'agenthub-dark' theme", () => {
    expect(monacoThemeFor("dark")).toBe("agenthub-dark");
  });

  it("maps 'light' to the custom 'agenthub-light' theme", () => {
    expect(monacoThemeFor("light")).toBe("agenthub-light");
  });
});

describe("modelPathFor (finding #1)", () => {
  it("percent-encodes each rel segment so paths differing only by '#' never collide", () => {
    const a = modelPathFor("ws1", "a#1.md");
    const b = modelPathFor("ws1", "a#2.md");
    expect(a).not.toBe(b);
    expect(a).not.toContain("#");
    expect(b).not.toContain("#");
  });

  it("keeps '/' as the segment separator, encoding each segment independently", () => {
    expect(modelPathFor("ws1", "a/b.txt")).toBe("/ws1/a/b.txt");
  });

  it("encodes the workspace id too", () => {
    expect(modelPathFor("ws with space", "f.txt")).toBe(`/${encodeURIComponent("ws with space")}/f.txt`);
  });

  it("never starts with the DiffEditor's 'compare-disk:'/'compare-mine:' prefixes (no collision, finding #1)", () => {
    expect(modelPathFor("ws1", "a.txt").startsWith("compare-disk:")).toBe(false);
    expect(modelPathFor("ws1", "a.txt").startsWith("compare-mine:")).toBe(false);
  });
});

describe("languageForRel", () => {
  it("maps common extensions to Monaco language ids", () => {
    expect(languageForRel("a.md")).toBe("markdown");
    expect(languageForRel("a.ts")).toBe("typescript");
    expect(languageForRel("a.unknownext")).toBe("plaintext");
  });
});
