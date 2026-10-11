import { describe, expect, it } from "vitest";
import { extractLinkCandidates } from "./linkCandidates";

describe("extractLinkCandidates", () => {
  it("finds a plain relative path", () => {
    const found = extractLinkCandidates("edit src/foo.ts now");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ pathPart: "src/foo.ts", line: null, column: null });
  });

  it("parses a leading './'/'.\\' relative path with a :line suffix", () => {
    const found = extractLinkCandidates(".\\src\\foo.ts:42");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ pathPart: ".\\src\\foo.ts", line: 42, column: null, text: ".\\src\\foo.ts:42" });
  });

  it("parses a :line:column suffix", () => {
    const found = extractLinkCandidates("src/foo.ts:42:7");
    expect(found[0]).toMatchObject({ pathPart: "src/foo.ts", line: 42, column: 7 });
  });

  it("parses an (line,column) suffix (MSBuild/tsc)", () => {
    const found = extractLinkCandidates("src/foo.ts(42,7): error TS2345");
    expect(found[0]).toMatchObject({ pathPart: "src/foo.ts", line: 42, column: 7, text: "src/foo.ts(42,7)" });
  });

  it("parses a Windows absolute path with a :line suffix", () => {
    const found = extractLinkCandidates("at C:\\dev\\proj\\src\\foo.ts:42");
    expect(found[0]).toMatchObject({ pathPart: "C:\\dev\\proj\\src\\foo.ts", line: 42 });
  });

  it("parses a Git Bash absolute path ('/c/...')", () => {
    const found = extractLinkCandidates("open /c/dev/proj/src/foo.ts");
    expect(found[0]).toMatchObject({ pathPart: "/c/dev/proj/src/foo.ts", line: null });
  });

  it("excludes URLs entirely (web-links addon owns those)", () => {
    const found = extractLinkCandidates("see https://example.com/a/b.ts:42 for details");
    expect(found).toHaveLength(0);
  });

  it("a bare filename with no separator is not a candidate (avoids noise)", () => {
    const found = extractLinkCandidates("just foo.ts here");
    expect(found).toHaveLength(0);
  });

  it("finds a path inside double quotes without including the quotes", () => {
    const found = extractLinkCandidates('Error in "src/foo.ts" at line 3');
    expect(found).toHaveLength(1);
    expect(found[0]?.pathPart).toBe("src/foo.ts");
    expect(found[0]?.text).not.toContain('"');
  });

  it("finds a path inside parentheses without swallowing the wrapping paren", () => {
    const found = extractLinkCandidates("(src/foo.ts:42)");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ pathPart: "src/foo.ts", line: 42 });
    expect(found[0]?.text).toBe("src/foo.ts:42");
  });

  it("finds multiple candidates on the same line", () => {
    const found = extractLinkCandidates("diff src/a.ts:1 vs src/b.ts:2");
    expect(found.map((c) => c.pathPart)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
