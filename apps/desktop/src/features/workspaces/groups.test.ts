import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceGroup } from "../../lib/ipc";
import { defaultCursor, displayOrder, groupedWorkspaces, groupNeighbour, rowKey, visibleRows } from "./groups";

const ws = (id: string, group?: string): Workspace => ({ id, name: id, path: `C:\\${id}`, expandedDirs: [], ...(group ? { group } : {}) });
const work: WorkspaceGroup = { id: "g-work", name: "Work" };
const games: WorkspaceGroup = { id: "g-games", name: "Games" };

describe("groupedWorkspaces", () => {
  it("without groups: one headerless section with everything, as before", () => {
    const sections = groupedWorkspaces([ws("a"), ws("b")], []);
    expect(sections).toEqual([{ group: null, workspaces: [ws("a"), ws("b")] }]);
  });

  it("groups in their order (empty ones too), then the ungrouped; dangling refs are ungrouped", () => {
    const list = [ws("a"), ws("b", "g-games"), ws("c", "gone"), ws("d", "g-games")];
    const sections = groupedWorkspaces(list, [work, games]);
    expect(sections.map((s) => [s.group?.name ?? null, s.workspaces.map((w) => w.id)])).toEqual([
      ["Work", []],
      ["Games", ["b", "d"]],
      [null, ["a", "c"]],
    ]);
  });

  it("no ungrouped section when every workspace has a group", () => {
    expect(groupedWorkspaces([ws("a", "g-work")], [work]).map((s) => s.group)).toEqual([work]);
  });
});

describe("displayOrder / groupNeighbour", () => {
  const list = [ws("a"), ws("b", "g-work"), ws("c"), ws("d", "g-work")];

  it("flattens sections, collapsed or not", () => {
    expect(displayOrder(list, [work]).map((w) => w.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("moves only inside the own section", () => {
    expect(groupNeighbour(list, [work], "d", "up")).toBe("b");
    expect(groupNeighbour(list, [work], "b", "up")).toBeNull();
    expect(groupNeighbour(list, [work], "d", "down")).toBeNull();
    expect(groupNeighbour(list, [work], "a", "down")).toBe("c");
    expect(groupNeighbour(list, [work], "a", "up")).toBeNull();
  });
});

describe("visibleRows / defaultCursor", () => {
  const list = [ws("a"), ws("b", "g-work")];
  const sections = groupedWorkspaces(list, [work]);

  it("headers for groups, hidden rows under a collapsed group", () => {
    expect(visibleRows(sections, new Set()).map(rowKey)).toEqual(["g:g-work", "w:b", "w:a"]);
    expect(visibleRows(sections, new Set(["g-work"])).map(rowKey)).toEqual(["g:g-work", "w:a"]);
  });

  it("the cursor falls on the active row, or its collapsed group's header", () => {
    const open = visibleRows(sections, new Set());
    expect(defaultCursor(open, list, [work], "b")).toBe("w:b");
    const closed = visibleRows(sections, new Set(["g-work"]));
    expect(defaultCursor(closed, list, [work], "b")).toBe("g:g-work");
    expect(defaultCursor(closed, list, [work], null)).toBe("g:g-work");
  });
});
