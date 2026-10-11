import { describe, expect, it } from "vitest";
import type { Agent } from "../../lib/ipc";
import {
  computeVisiblePaneId,
  countsByState,
  decideNotifications,
  formatElapsed,
  nextBlockedTarget,
  sortAgents,
  stateForPane,
  urgentStateForWorkspace,
} from "./agentLogic";

function agent(partial: Partial<Agent> & Pick<Agent, "id" | "paneId" | "state">): Agent {
  return {
    workspaceId: "ws1",
    kind: "claude",
    sinceMs: 0,
    source: "hook",
    sessionId: null,
    ...partial,
  };
}

describe("sortAgents", () => {
  it("orders blocked > done > working > idle", () => {
    const agents = [
      agent({ id: "a", paneId: "p1", state: "idle" }),
      agent({ id: "b", paneId: "p2", state: "working" }),
      agent({ id: "c", paneId: "p3", state: "blocked" }),
      agent({ id: "d", paneId: "p4", state: "done" }),
    ];
    expect(sortAgents(agents).map((a) => a.state)).toEqual(["blocked", "done", "working", "idle"]);
  });

  it("ties within the same state put the older sinceMs first", () => {
    const agents = [
      agent({ id: "a", paneId: "p1", state: "blocked", sinceMs: 200 }),
      agent({ id: "b", paneId: "p2", state: "blocked", sinceMs: 100 }),
    ];
    expect(sortAgents(agents).map((a) => a.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the input array", () => {
    const agents = [agent({ id: "a", paneId: "p1", state: "idle" }), agent({ id: "b", paneId: "p2", state: "blocked" })];
    const copy = [...agents];
    sortAgents(agents);
    expect(agents).toEqual(copy);
  });
});

describe("urgentStateForWorkspace", () => {
  it("picks the most urgent state within the workspace only", () => {
    const agents = [
      agent({ id: "a", paneId: "p1", state: "idle", workspaceId: "ws1" }),
      agent({ id: "b", paneId: "p2", state: "blocked", workspaceId: "ws2" }),
      agent({ id: "c", paneId: "p3", state: "working", workspaceId: "ws1" }),
    ];
    expect(urgentStateForWorkspace(agents, "ws1")).toBe("working");
    expect(urgentStateForWorkspace(agents, "ws2")).toBe("blocked");
  });

  it("returns null when the workspace has no agents", () => {
    expect(urgentStateForWorkspace([], "ws1")).toBeNull();
  });
});

describe("stateForPane", () => {
  it("returns the agent's state for a known pane, else null", () => {
    const agents = [agent({ id: "a", paneId: "p1", state: "working" })];
    expect(stateForPane(agents, "p1")).toBe("working");
    expect(stateForPane(agents, "unknown")).toBeNull();
  });
});

describe("countsByState", () => {
  it("counts every state, defaulting to zero", () => {
    const agents = [
      agent({ id: "a", paneId: "p1", state: "blocked" }),
      agent({ id: "b", paneId: "p2", state: "blocked" }),
      agent({ id: "c", paneId: "p3", state: "working" }),
    ];
    expect(countsByState(agents)).toEqual({ blocked: 2, working: 1, done: 0, idle: 0 });
  });
});

describe("formatElapsed", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatElapsed(12_000, 0)).toBe("12s");
    expect(formatElapsed(0, 0)).toBe("0s");
  });

  it("formats sub-hour durations as minutes", () => {
    expect(formatElapsed(3 * 60_000, 0)).toBe("3m");
    expect(formatElapsed(59 * 60_000 + 59_000, 0)).toBe("59m");
  });

  it("formats hour-plus durations as 'Xh Ym', omitting minutes when zero", () => {
    expect(formatElapsed(60 * 60_000, 0)).toBe("1h");
    expect(formatElapsed(65 * 60_000, 0)).toBe("1h 5m");
  });

  it("clamps a negative difference to zero instead of going negative", () => {
    expect(formatElapsed(0, 5_000)).toBe("0s");
  });
});

describe("nextBlockedTarget", () => {
  const sorted = [
    agent({ id: "a", paneId: "p1", state: "blocked" }),
    agent({ id: "b", paneId: "p2", state: "blocked" }),
    agent({ id: "c", paneId: "p3", state: "working" }),
  ];

  it("returns null when there is no blocked agent", () => {
    expect(nextBlockedTarget([agent({ id: "a", paneId: "p1", state: "idle" })], null)).toBeNull();
  });

  it("returns the first blocked agent when nothing is focused", () => {
    expect(nextBlockedTarget(sorted, null)?.id).toBe("a");
  });

  it("returns the next blocked agent after the focused pane", () => {
    expect(nextBlockedTarget(sorted, "p1")?.id).toBe("b");
  });

  it("wraps around to the first blocked agent when the focused pane is the last blocked one", () => {
    expect(nextBlockedTarget(sorted, "p2")?.id).toBe("a");
  });

  it("falls back to the first blocked agent when the focused pane isn't in the list", () => {
    expect(nextBlockedTarget(sorted, "unknown-pane")?.id).toBe("a");
  });
});

describe("decideNotifications", () => {
  it("returns nothing when the window is focused", () => {
    const prev = [agent({ id: "a", paneId: "p1", state: "working" })];
    const next = [agent({ id: "a", paneId: "p1", state: "blocked" })];
    expect(decideNotifications(prev, next, true)).toEqual([]);
  });

  it("notifies for a transition into blocked or done", () => {
    const prev = [
      agent({ id: "a", paneId: "p1", state: "working" }),
      agent({ id: "b", paneId: "p2", state: "working" }),
    ];
    const next = [
      agent({ id: "a", paneId: "p1", state: "blocked" }),
      agent({ id: "b", paneId: "p2", state: "done" }),
    ];
    const result = decideNotifications(prev, next, false);
    expect(result.map((r) => [r.agent.id, r.kind])).toEqual([
      ["a", "blocked"],
      ["b", "done"],
    ]);
  });

  it("does not notify for an agent absent from prev (initial snapshot seeds silently)", () => {
    const next = [agent({ id: "a", paneId: "p1", state: "blocked" })];
    expect(decideNotifications([], next, false)).toEqual([]);
  });

  it("does not notify when the state didn't change", () => {
    const prev = [agent({ id: "a", paneId: "p1", state: "blocked" })];
    const next = [agent({ id: "a", paneId: "p1", state: "blocked" })];
    expect(decideNotifications(prev, next, false)).toEqual([]);
  });

  it("does not notify for a transition into working or idle", () => {
    const prev = [agent({ id: "a", paneId: "p1", state: "blocked" })];
    const next = [agent({ id: "a", paneId: "p1", state: "idle" })];
    expect(decideNotifications(prev, next, false)).toEqual([]);
  });
});

describe("computeVisiblePaneId", () => {
  it("returns null when there is no active workspace", () => {
    expect(computeVisiblePaneId({ activeWorkspaceId: null, terminalVisible: true, activeTabPaneId: "p1" })).toBeNull();
  });

  it("returns null when the terminal column is hidden", () => {
    expect(computeVisiblePaneId({ activeWorkspaceId: "ws1", terminalVisible: false, activeTabPaneId: "p1" })).toBeNull();
  });

  it("returns the active tab's paneId when visible", () => {
    expect(computeVisiblePaneId({ activeWorkspaceId: "ws1", terminalVisible: true, activeTabPaneId: "p1" })).toBe("p1");
  });

  it("returns null when the active tab has no paneId yet (not started)", () => {
    expect(computeVisiblePaneId({ activeWorkspaceId: "ws1", terminalVisible: true, activeTabPaneId: undefined })).toBeNull();
  });
});
