import { describe, expect, it } from "vitest";
import type { AdapterDefinition, Agent } from "../../lib/ipc";
import { makeSession } from "../workspace/sessionFixture";
import { buildSnapshot, newApprovals, silentResolutions, type SnapshotInput } from "./companionSnapshot";
import { formatClock, pomodoroSecondsLeft } from "./PomodoroChip";

function def(id: string, permissionKeys: AdapterDefinition["permissionKeys"]): AdapterDefinition {
  return { v: 1, id, displayName: id === "claude-code" ? "Claude Code" : id, avatar: null, detect: { executables: [], nodeScripts: [] }, launch: null, gracefulClose: [], permissionKeys, screenRules: [], source: "builtIn" };
}

function agent(partial: Partial<Agent>): Agent {
  return { id: "p1", paneId: "p1", workspaceId: "w", kind: "claude", adapterId: "claude-code", state: "idle", sinceMs: 0, source: "hook", sessionId: null, ...partial };
}

const DEFS = [def("claude-code", { allowOnce: "1", alwaysAllow: "2", deny: "Esc" }), def("droid", null)];

function input(partial: Partial<SnapshotInput>): SnapshotInput {
  return {
    panes: [{ paneId: "p1", workspaceName: "ws" }],
    agents: [agent({})],
    sessions: [],
    definitions: DEFS,
    displayName: (id) => DEFS.find((d) => d.id === id)?.displayName ?? id,
    kindLabel: (a) => a.kind,
    ...partial,
  };
}

const waiting = makeSession({
  paneId: "p1",
  state: "WaitingPermission",
  stateSince: "2026-10-04T10:00:00Z",
  pendingPermission: { tool: "Bash", command: "cargo build --release", path: null, risk: null, since: "2026-10-04T10:00:00Z" },
});

describe("buildSnapshot", () => {
  it("lists pane agents with deck statuses and an answerable approval with the card's keys", () => {
    const snap = buildSnapshot(input({ sessions: [waiting] }));
    expect(snap.state.agents).toEqual([
      { id: "pane:p1", repo: "app", name: "Claude Code", status: "waiting", task: "Bash: cargo build --release", since: Date.parse("2026-10-04T10:00:00Z") },
    ]);
    const id = "claude-code:s1:2026-10-04T10:00:00Z";
    expect(snap.state.approvals).toEqual([
      { id, agentId: "pane:p1", summary: "Bash", detail: "cargo build --release", requestedAt: Date.parse("2026-10-04T10:00:00Z") },
    ]);
    expect(snap.targets[id]).toEqual({ paneId: "p1", allowKey: "1", denyKey: "Esc" });
  });

  it("keeps questions and keyless agents out of approvals but shows them waiting", () => {
    const question = makeSession({ ...waiting, pendingPermission: { ...waiting.pendingPermission!, tool: "AskUserQuestion" } });
    const q = buildSnapshot(input({ sessions: [question] }));
    expect(q.state.approvals).toEqual([]);
    expect(q.state.agents[0]!.status).toBe("waiting");

    const droid = buildSnapshot(input({ agents: [agent({ adapterId: "droid" })], sessions: [{ ...waiting, agent: "droid" }] }));
    expect(droid.state.approvals).toEqual([]);
    expect(droid.state.agents[0]!.status).toBe("waiting");
  });

  it("adds hub sessions from other terminals without approvals and skips ended ones", () => {
    const outside = makeSession({ sessionId: "x", paneId: null, state: "WaitingPermission", pendingPermission: waiting.pendingPermission });
    const ended = makeSession({ sessionId: "e", state: "Ended" });
    const snap = buildSnapshot(input({ panes: [], agents: [], sessions: [outside, ended] }));
    expect(snap.state.agents.map((a) => [a.id, a.status])).toEqual([["claude-code:x", "waiting"]]);
    expect(snap.state.approvals).toEqual([]);
  });

  it("maps working, done and idle, and uses the workspace name without a hub session", () => {
    const working = buildSnapshot(input({ sessions: [makeSession({ paneId: "p1", state: "Working", currentTool: "Edit" })] }));
    expect(working.state.agents[0]).toMatchObject({ status: "working", task: "Edit" });
    const tracker = buildSnapshot(input({ agents: [agent({ state: "done", sinceMs: 5 })] }));
    expect(tracker.state.agents[0]).toEqual({ id: "pane:p1", repo: "ws", name: "Claude Code", status: "idle", since: 5 });
    expect(buildSnapshot(input({ agents: [] })).state.agents).toEqual([]);
  });
});

describe("approval changes", () => {
  const before = buildSnapshot(input({ sessions: [waiting] }));
  const id = before.state.approvals[0]!.id;

  it("finds new approvals", () => {
    const empty = buildSnapshot(input({}));
    expect(newApprovals(empty, before).map((a) => a.id)).toEqual([id]);
    expect(newApprovals(before, before)).toEqual([]);
  });

  it("resolves a vanished prompt as unknown, or expired when the agent is gone, unless already reported", () => {
    const answeredInTerminal = buildSnapshot(input({ sessions: [{ ...waiting, state: "Working", pendingPermission: null }] }));
    expect(silentResolutions(before, answeredInTerminal, new Set())).toEqual([{ id, decision: "unknown", by: "agent" }]);
    const gone = buildSnapshot(input({ panes: [], agents: [] }));
    expect(silentResolutions(before, gone, new Set())).toEqual([{ id, decision: "expired", by: "agent" }]);
    expect(silentResolutions(before, gone, new Set([id]))).toEqual([]);
  });
});

describe("pomodoro chip", () => {
  const base = { phase: "focus", running: true, endsAt: 100_000, remaining: 1500, duration: 1500, session: 1, sessionsPerCycle: 4 };
  it("counts down from endsAt while running and shows remaining while paused", () => {
    expect(pomodoroSecondsLeft(base, 40_000)).toBe(60);
    expect(pomodoroSecondsLeft(base, 200_000)).toBe(0);
    expect(pomodoroSecondsLeft({ ...base, running: false, endsAt: null, remaining: 754 }, 0)).toBe(754);
    expect(formatClock(754)).toBe("12:34");
    expect(formatClock(5)).toBe("0:05");
  });
});
