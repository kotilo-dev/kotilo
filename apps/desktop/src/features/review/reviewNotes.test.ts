import { describe, expect, it } from "vitest";
import { buildReviewPrompt, codeAt, linesOf, MAX_QUOTED_LINES, reanchor, type ReviewNote } from "./reviewNotes";

function note(over: Partial<ReviewNote>): ReviewNote {
  return {
    id: "n1",
    workspaceId: "ws",
    rel: "src/a.ts",
    startLine: 2,
    endLine: 2,
    code: "b",
    text: "rename",
    resolved: false,
    outdated: false,
    ...over,
  };
}

describe("reanchor", () => {
  it("keeps a note whose lines did not move", () => {
    const n = note({});
    expect(reanchor(n, ["a", "b", "c"])).toBe(n);
  });

  it("follows lines that moved, to the nearest match", () => {
    const n = note({ startLine: 2, endLine: 3, code: "b\nc" });
    expect(reanchor(n, ["x", "x", "a", "b", "c", "b", "c"])).toMatchObject({ startLine: 4, endLine: 5, outdated: false });
  });

  it("marks a note outdated when its lines are gone and clamps it to the file", () => {
    const n = note({ startLine: 5, endLine: 6, code: "e\nf" });
    expect(reanchor(n, ["a", "b"])).toMatchObject({ startLine: 2, endLine: 2, outdated: true });
  });

  it("clears outdated when the lines come back", () => {
    const n = note({ outdated: true });
    expect(reanchor(n, ["a", "b"])).toMatchObject({ outdated: false });
  });
});

describe("buildReviewPrompt", () => {
  it("lists notes by file and line with the quoted code", () => {
    const prompt = buildReviewPrompt([
      note({ id: "2", rel: "src/b.ts", startLine: 3, endLine: 4, code: "x\ny", text: "split this" }),
      note({ id: "1", rel: "src/a.ts", startLine: 7, endLine: 7, code: "const a = 1;", text: "  use a constant  " }),
    ]);
    expect(prompt).toBe(
      [
        "Please address these review notes on the current changes:",
        "",
        "1. src/a.ts:7",
        "```",
        "const a = 1;",
        "```",
        "use a constant",
        "",
        "2. src/b.ts:3-4",
        "```",
        "x",
        "y",
        "```",
        "split this",
      ].join("\n"),
    );
  });

  it("uses a longer fence when the code contains one, cuts long ranges and flags outdated notes", () => {
    const long = Array.from({ length: MAX_QUOTED_LINES + 5 }, (_, i) => `line ${i}`).join("\n");
    const prompt = buildReviewPrompt([
      note({ code: "```md\n```", outdated: true }),
      note({ id: "2", rel: "src/z.ts", startLine: 1, endLine: MAX_QUOTED_LINES + 5, code: long }),
    ]);
    expect(prompt).toContain("src/a.ts:2 (these lines have changed since)\n````\n```md\n```\n````");
    expect(prompt).toContain("… (5 more lines)");
    expect(prompt).not.toContain(`line ${MAX_QUOTED_LINES}\n`);
  });
});

describe("helpers", () => {
  it("splits CRLF and LF and clamps line ranges", () => {
    const lines = linesOf("a\r\nb\nc");
    expect(lines).toEqual(["a", "b", "c"]);
    expect(codeAt(lines, 2, 9)).toBe("b\nc");
  });
});
