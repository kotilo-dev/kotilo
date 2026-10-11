import { describe, expect, it } from "vitest";
import { findWorkspaceFile, joinProjectPath } from "./projectLogic";

describe("projectLogic", () => {
  const workspaces = [
    { id: "w1", path: String.raw`C:\src` },
    { id: "w2", path: String.raw`C:\src\app` },
  ];

  it("joins with backslashes", () => {
    expect(joinProjectPath(String.raw`C:\src\app\ `.trim(), "tasks/todo.md")).toBe(String.raw`C:\src\app\tasks\todo.md`);
  });

  it("finds the deepest workspace and a slash rel", () => {
    expect(findWorkspaceFile(workspaces, String.raw`C:\src\app\tasks\todo.md`)).toEqual({ workspaceId: "w2", rel: "tasks/todo.md" });
    expect(findWorkspaceFile(workspaces, "c:/SRC/lib/a.md")).toEqual({ workspaceId: "w1", rel: "lib/a.md" });
  });

  it("returns null outside every workspace and for a sibling with a common prefix", () => {
    expect(findWorkspaceFile(workspaces, String.raw`D:\other\todo.md`)).toBeNull();
    expect(findWorkspaceFile(workspaces, String.raw`C:\src-old\todo.md`)).toBeNull();
  });
});
