import { describe, expect, it } from "vitest";
import { flattenVisible } from "./flatten";

describe("flattenVisible", () => {
  it("no active workspace → no rows", () => {
    expect(flattenVisible({ dirCache: {}, expanded: {}, workspaceId: null })).toEqual([]);
    expect(flattenVisible({ dirCache: {}, expanded: {}, workspaceId: undefined })).toEqual([]);
  });

  it("only the given workspace's contents, no root or group rows, depth starts at 0", () => {
    const dirCache = {
      a: { "": [{ name: "x.ts", rel: "x.ts", isDir: false }] },
      b: { "": [{ name: "y.ts", rel: "y.ts", isDir: false }] },
    } as never;
    const rows = flattenVisible({ dirCache, expanded: { a: new Set([""]), b: new Set([""]) }, workspaceId: "b" });
    expect(rows).toEqual([{ kind: "file", workspaceId: "b", rel: "y.ts", name: "y.ts", depth: 0 }]);
  });

  it("the root counts as expanded even when it is not in the expanded set", () => {
    const rows = flattenVisible({
      dirCache: { a: { "": [{ name: "src", rel: "src", isDir: true }, { name: "README.md", rel: "README.md", isDir: false }] } },
      expanded: {},
      workspaceId: "a",
    });
    expect(rows).toEqual([
      { kind: "dir", workspaceId: "a", rel: "src", name: "src", depth: 0, expanded: false },
      { kind: "file", workspaceId: "a", rel: "README.md", name: "README.md", depth: 0 },
    ]);
  });

  it("nested open folders expand recursively at the right depth", () => {
    const rows = flattenVisible({
      dirCache: {
        a: {
          "": [{ name: "src", rel: "src", isDir: true }],
          src: [{ name: "app", rel: "src/app", isDir: true }],
          "src/app": [{ name: "App.tsx", rel: "src/app/App.tsx", isDir: false }],
        },
      },
      expanded: { a: new Set(["src", "src/app"]) },
      workspaceId: "a",
    });
    expect(rows.map((r) => [r.kind, "rel" in r ? r.rel : "", r.depth])).toEqual([
      ["dir", "src", 0],
      ["dir", "src/app", 1],
      ["file", "src/app/App.tsx", 2],
    ]);
  });

  it("an open folder whose contents are not loaded yet yields no child rows", () => {
    const rows = flattenVisible({
      dirCache: { a: { "": [{ name: "src", rel: "src", isDir: true }] } },
      expanded: { a: new Set(["src"]) },
      workspaceId: "a",
    });
    expect(rows).toEqual([{ kind: "dir", workspaceId: "a", rel: "src", name: "src", depth: 0, expanded: true }]);
  });

  it("loading state yields a loading row", () => {
    const rows = flattenVisible({ dirCache: { a: { "": "loading" } }, expanded: {}, workspaceId: "a" });
    expect(rows).toEqual([{ kind: "loading", workspaceId: "a", rel: "", depth: 0 }]);
  });

  it("error state yields an error row", () => {
    const error = { code: "not_found" as const, message: "gone" };
    const rows = flattenVisible({ dirCache: { a: { "": { error } } }, expanded: {}, workspaceId: "a" });
    expect(rows).toEqual([{ kind: "error", workspaceId: "a", rel: "", depth: 0, error }]);
  });

  it("a collapsed sub-folder's contents are never flattened (performance)", () => {
    const rows = flattenVisible({
      dirCache: {
        a: {
          "": [{ name: "src", rel: "src", isDir: true }],
          src: [{ name: "hidden.ts", rel: "src/hidden.ts", isDir: false }],
        },
      },
      expanded: {},
      workspaceId: "a",
    });
    expect(rows.some((r) => "rel" in r && r.rel === "src/hidden.ts")).toBe(false);
  });
});
