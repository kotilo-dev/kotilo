import { describe, expect, it } from "vitest";
import type { SessionDto, SessionState } from "../../lib/hubTypes";
import { countGroups, fallbackLines, filterSessions, groupOf, hasUnseen, lastNonBlankLines, liveSessions, sameLines } from "./missionLogic";

function session(partial: Partial<SessionDto>): SessionDto {
  return {
    sessionId: "s",
    agent: "claude-code",
    paneId: null,
    projectRoot: "C:/src/app",
    projectName: "app",
    state: "Idle",
    stateSince: "2026-10-04T10:00:00Z",
    lastEventAt: "2026-10-04T10:00:00Z",
    currentTool: null,
    model: null,
    tokens: 0,
    costUsd: null,
    contextUsedPercent: null,
    lastCompletedAt: null,
    unseen: false,
    turnStartedAt: null,
    endedAt: null,
    activeSubagents: 0,
    lastNotification: null,
    error: null,
    tasks: null,
    pendingPermission: null,
    ...partial,
  };
}

// Idle ones are unseen finished work ("done") unless a test says otherwise.
const byState = (...states: SessionState[]) => states.map((state, i) => session({ sessionId: `s${i}`, state, unseen: state === "Idle" }));

describe("missionLogic", () => {
  it("groups states into needs-you / working / done", () => {
    const g = (state: SessionState, unseen = false) => groupOf({ state, unseen });
    expect(g("WaitingPermission")).toBe("attention");
    expect(g("WaitingInput")).toBe("attention");
    expect(g("Error")).toBe("attention");
    expect(g("Working")).toBe("working");
    expect(g("Idle", true)).toBe("done");
    expect(g("Stale")).toBeNull();
  });

  it("counts only unseen finished work as done; seen idle sessions sort after it (D-056)", () => {
    expect(groupOf({ state: "Idle", unseen: false })).toBeNull();
    const seen = session({ sessionId: "seen", state: "Idle" });
    const unseen = session({ sessionId: "unseen", state: "Idle", unseen: true });
    const stale = session({ sessionId: "stale", state: "Stale" });
    expect(liveSessions([stale, seen, unseen]).map((s) => s.sessionId)).toEqual(["unseen", "seen", "stale"]);
    expect(countGroups([seen, unseen])).toEqual({ all: 2, attention: 0, working: 0, done: 1 });
    expect(hasUnseen([seen])).toBe(false);
    expect(hasUnseen([seen, unseen])).toBe(true);
    expect(hasUnseen([session({ state: "Ended", unseen: true })])).toBe(false);
  });

  it("drops ended sessions and orders needs-you, working, done, rest (stable)", () => {
    const live = liveSessions(byState("Idle", "Working", "Ended", "Stale", "WaitingInput", "Unknown", "Working", "Error"));
    expect(live.map((s) => `${s.sessionId}:${s.state}`)).toEqual([
      "s4:WaitingInput",
      "s7:Error",
      "s1:Working",
      "s6:Working",
      "s0:Idle",
      "s3:Stale",
    ]);
  });

  it("filters and counts", () => {
    const live = liveSessions(byState("Idle", "Working", "WaitingPermission", "Stale", "Working"));
    expect(countGroups(live)).toEqual({ all: 5, attention: 1, working: 2, done: 1 });
    expect(filterSessions(live, "working").map((s) => s.state)).toEqual(["Working", "Working"]);
    expect(filterSessions(live, "all")).toHaveLength(5);
    expect(filterSessions(live, "done").map((s) => s.state)).toEqual(["Idle"]);
  });

  it("takes the last five non-blank lines, right-trimmed", () => {
    const rows = ["one", "two   ", "", "three", "   ", "four", "five", "six", "", "", "    "];
    expect(lastNonBlankLines(rows)).toEqual(["two", "three", "four", "five", "six"]);
    expect(lastNonBlankLines(["  indented  ", ""], 5)).toEqual(["  indented"]);
    expect(lastNonBlankLines([])).toEqual([]);
  });

  it("compares line arrays", () => {
    expect(sameLines(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameLines(["a"], ["a", "b"])).toBe(false);
    expect(sameLines(undefined, [])).toBe(false);
  });

  it("builds a fallback preview from metadata only", () => {
    expect(fallbackLines(session({}))).toEqual([]);
    const waiting = session({
      currentTool: "Bash",
      lastNotification: "Claude needs your permission to use Bash",
      pendingPermission: { tool: "Bash", command: "x".repeat(500), path: null, risk: null, since: "2026-10-04T10:00:00Z" },
    });
    const lines = fallbackLines(waiting);
    expect(lines[0]).toEqual({ kind: "permission", tool: "Bash", target: "x".repeat(200) });
    expect(lines[1]).toEqual({ kind: "notification", text: "Claude needs your permission to use Bash" });
    // The current tool is the permission's tool: not repeated.
    expect(lines).toHaveLength(2);
    expect(fallbackLines(session({ currentTool: "Edit" }))).toEqual([{ kind: "tool", tool: "Edit" }]);
  });
});
