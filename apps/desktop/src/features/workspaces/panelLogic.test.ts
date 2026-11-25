import { describe, expect, it } from "vitest";
import type { Agent, Workspace } from "../../lib/ipc";
import { blockedElsewhereCount } from "./panelLogic";
import { effectivePanelTab } from "../../stores/workspacePanelStore";

const ws = (id: string): Workspace => ({ id, name: id, path: `C:\dev\${id}`, expandedDirs: [] });
const agent = (workspaceId: string, state: Agent["state"]): Agent => ({
  id: `${workspaceId}-${state}`,
  paneId: `p-${workspaceId}-${state}`,
  workspaceId,
  kind: "claude",
  state,
  sinceMs: 0,
  source: "hook",
  sessionId: null,
});

describe("blockedElsewhereCount", () => {
  const list = [ws("a"), ws("b"), ws("c")];

  it("counts workspaces, not agents, and skips the active one", () => {
    const agents = [agent("a", "blocked"), agent("b", "blocked"), agent("b", "working"), agent("c", "working")];
    expect(blockedElsewhereCount(agents, list, "a")).toBe(1);
    expect(blockedElsewhereCount(agents, list, null)).toBe(2);
  });

  it("is zero without agents", () => {
    expect(blockedElsewhereCount([], list, "a")).toBe(0);
  });
});

describe("effectivePanelTab", () => {
  it("defaults to Files, or Workspaces without an active workspace", () => {
    expect(effectivePanelTab(null, true)).toBe("files");
    expect(effectivePanelTab(null, false)).toBe("workspaces");
  });

  it("honours the user's choice, but never Files without an active workspace", () => {
    expect(effectivePanelTab("workspaces", true)).toBe("workspaces");
    expect(effectivePanelTab("files", false)).toBe("workspaces");
  });
});
