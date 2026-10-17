import { describe, expect, it } from "vitest";
import { flattenVisible } from "./flatten";
import type { Workspace } from "../../lib/ipc";

function ws(id: string, name: string): Workspace {
  return { id, name, path: `C:\\dev\\${name}`, expandedDirs: [] };
}

describe("flattenVisible", () => {
  it("kapalı kökler yalnızca kök satırı üretir", () => {
    const rows = flattenVisible({
      workspaces: [ws("a", "a-ws")],
      dirCache: {},
      expanded: {},
    });
    expect(rows).toEqual([{ kind: "root", workspaceId: "a", workspace: ws("a", "a-ws"), depth: 0, expanded: false }]);
  });

  it("activeId verilince yalnızca aktif workspace'in ağacı açılır", () => {
    const dirCache = {
      a: { "": [{ name: "x.ts", rel: "x.ts", isDir: false }] },
      b: { "": [{ name: "y.ts", rel: "y.ts", isDir: false }] },
    } as never;
    const expanded = { a: new Set([""]), b: new Set([""]) };
    const rows = flattenVisible({ workspaces: [ws("a", "a-ws"), ws("b", "b-ws")], dirCache, expanded, activeId: "b" });
    expect(rows.map((r) => [r.kind, r.workspaceId, r.kind === "root" ? r.expanded : null])).toEqual([
      ["root", "b", true],
      ["file", "b", null],
      ["group", "", null],
      ["root", "a", false],
    ]);
    const none = flattenVisible({ workspaces: [ws("a", "a-ws")], dirCache, expanded, activeId: null });
    expect(none).toHaveLength(1);
  });

  it("aktif workspace en üstte; diğerleri kendi sıralarıyla grup başlığının altında", () => {
    const list = [ws("a", "a-ws"), ws("b", "b-ws"), ws("c", "c-ws")];
    const rows = flattenVisible({ workspaces: list, dirCache: {}, expanded: {}, activeId: "b" });
    expect(rows.map((r) => (r.kind === "group" ? `group:${r.count}` : r.workspaceId))).toEqual(["b", "group:2", "a", "c"]);
    const alone = flattenVisible({ workspaces: [ws("a", "a-ws")], dirCache: {}, expanded: {}, activeId: "a" });
    expect(alone.map((r) => r.kind)).toEqual(["root"]);
    const none = flattenVisible({ workspaces: list, dirCache: {}, expanded: {}, activeId: null });
    expect(none.map((r) => r.kind)).toEqual(["root", "root", "root"]);
  });

  it("workspace sırası korunur", () => {
    const rows = flattenVisible({
      workspaces: [ws("a", "a-ws"), ws("b", "b-ws")],
      dirCache: {},
      expanded: {},
    });
    expect(rows.map((r) => r.workspaceId)).toEqual(["a", "b"]);
  });

  it("açık kök klasör önce, sonra dosyalar sırayla listelenir (backend sırası korunur)", () => {
    const rows = flattenVisible({
      workspaces: [ws("a", "a-ws")],
      dirCache: {
        a: {
          "": [
            { name: "src", rel: "src", isDir: true },
            { name: "README.md", rel: "README.md", isDir: false },
          ],
        },
      },
      expanded: { a: new Set([""]) },
    });
    expect(rows).toEqual([
      { kind: "root", workspaceId: "a", workspace: ws("a", "a-ws"), depth: 0, expanded: true },
      { kind: "dir", workspaceId: "a", rel: "src", name: "src", depth: 1, expanded: false },
      { kind: "file", workspaceId: "a", rel: "README.md", name: "README.md", depth: 1 },
    ]);
  });

  it("iç içe açık klasörler doğru derinlikte özyinelemeli genişler", () => {
    const rows = flattenVisible({
      workspaces: [ws("a", "a-ws")],
      dirCache: {
        a: {
          "": [{ name: "src", rel: "src", isDir: true }],
          src: [{ name: "app", rel: "src/app", isDir: true }],
          "src/app": [{ name: "App.tsx", rel: "src/app/App.tsx", isDir: false }],
        },
      },
      expanded: { a: new Set(["", "src", "src/app"]) },
    });
    expect(rows.map((r) => [r.kind, "rel" in r ? r.rel : "<root>", r.depth])).toEqual([
      ["root", "<root>", 0],
      ["dir", "src", 1],
      ["dir", "src/app", 2],
      ["file", "src/app/App.tsx", 3],
    ]);
  });

  it("açık ama içeriği henüz yüklenmemiş klasör hiçbir çocuk satırı üretmez", () => {
    const rows = flattenVisible({
      workspaces: [ws("a", "a-ws")],
      dirCache: { a: { "": [{ name: "src", rel: "src", isDir: true }] } },
      expanded: { a: new Set(["", "src"]) }, // "src" açık ama dirCache["a"]["src"] yok
    });
    expect(rows).toEqual([
      { kind: "root", workspaceId: "a", workspace: ws("a", "a-ws"), depth: 0, expanded: true },
      { kind: "dir", workspaceId: "a", rel: "src", name: "src", depth: 1, expanded: true },
    ]);
  });

  it("yükleniyor durumu için loading satırı", () => {
    const rows = flattenVisible({
      workspaces: [ws("a", "a-ws")],
      dirCache: { a: { "": "loading" } },
      expanded: { a: new Set([""]) },
    });
    expect(rows[1]).toEqual({ kind: "loading", workspaceId: "a", rel: "", depth: 1 });
  });

  it("hata durumu için error satırı", () => {
    const error = { code: "not_found" as const, message: "yok" };
    const rows = flattenVisible({
      workspaces: [ws("a", "a-ws")],
      dirCache: { a: { "": { error } } },
      expanded: { a: new Set([""]) },
    });
    expect(rows[1]).toEqual({ kind: "error", workspaceId: "a", rel: "", depth: 1, error });
  });

  it("kapalı alt klasörün içeriği hiç düzleştirilmez (performans)", () => {
    const rows = flattenVisible({
      workspaces: [ws("a", "a-ws")],
      dirCache: {
        a: {
          "": [{ name: "src", rel: "src", isDir: true }],
          src: [{ name: "hidden.ts", rel: "src/hidden.ts", isDir: false }],
        },
      },
      expanded: { a: new Set([""]) }, // "src" kapalı
    });
    expect(rows.some((r) => "rel" in r && r.rel === "src/hidden.ts")).toBe(false);
  });
});
