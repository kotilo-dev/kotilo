import { describe, expect, it } from "vitest";
import type { SessionDto, SessionState } from "../../lib/hubTypes";
import { countGroups, fallbackLines, filterSessions, groupOf, lastNonBlankLines, liveSessions, sameLines } from "./missionLogic";

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

const byState = (...states: SessionState[]) => states.map((state, i) => session({ sessionId: `s${i}`, state }));

describe("missionLogic", () => {
  it("groups states into needs-you / working / done", () => {
    expect(groupOf("WaitingPermission")).toBe("attention");
    expect(groupOf("WaitingInput")).toBe("attention");
    expect(groupOf("Error")).toBe("attention");
    expect(groupOf("Working")).toBe("working");
    expect(groupOf("Idle")).toBe("done");
    expect(groupOf("Stale")).toBeNull();
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
