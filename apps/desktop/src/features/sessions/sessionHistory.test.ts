import { describe, expect, it } from "vitest";
import type { SessionHistoryRow } from "../../lib/hubTypes";
import { filterSessions, groupSessions, isSafeSessionId, resumeCommand, workspaceForFolder } from "./sessionHistory";

function row(over: Partial<SessionHistoryRow>): SessionHistoryRow {
  return {
    sessionId: "6f1c2d3e-0000-4000-8000-000000000001",
    agent: "claude-code",
    projectRoot: "C:\\src\\orders-service",
    projectName: "orders-service",
    model: "claude-sonnet-5",
    state: "Ended",
    live: false,
    paneId: null,
    startedAt: "2026-10-25T09:00:00Z",
    lastEventAt: "2026-10-25T10:00:00Z",
    endedAt: "2026-10-25T10:00:00Z",
    tokens: 1000,
    costUsd: 0.5,
    ...over,
  };
}

const names = (id: string) => ({ "claude-code": "Claude Code", codex: "Codex" })[id] ?? id;

describe("resumeCommand", () => {
  it("fills the session id into the adapter's resume arguments", () => {
    expect(resumeCommand({ command: "claude", resumeArgs: ["--resume", "{sessionId}"] }, "abc-123")).toBe("claude --resume abc-123");
    expect(resumeCommand({ command: "codex", resumeArgs: ["resume", "{sessionId}"] }, "abc")).toBe("codex resume abc");
    expect(resumeCommand({ command: "x", resumeArgs: ["--session={sessionId}"] }, "ses_1")).toBe("x --session=ses_1");
  });

  it("gives no command without resume arguments or for an unsafe id", () => {
    expect(resumeCommand({ command: "agent" }, "abc")).toBeNull();
    expect(resumeCommand({ command: "agent", resumeArgs: ["--resume"] }, "abc")).toBeNull();
    expect(resumeCommand(null, "abc")).toBeNull();
    expect(resumeCommand({ command: "claude", resumeArgs: ["--resume", "{sessionId}"] }, "a; rm -rf /")).toBeNull();
    expect(isSafeSessionId("-rf")).toBe(false);
    expect(isSafeSessionId("ses_01HXYZ")).toBe(true);
  });
});

describe("workspaceForFolder", () => {
  const workspaces = [
    { id: "a", path: "C:\\src" },
    { id: "b", path: "C:\\src\\orders-service" },
  ];

  it("picks the deepest workspace and the folder inside it", () => {
    expect(workspaceForFolder(workspaces, "c:\\SRC\\orders-service", true)).toEqual({ workspaceId: "b", cwdRel: "" });
    expect(workspaceForFolder(workspaces, "C:\\src\\orders-service\\api\\", true)).toEqual({ workspaceId: "b", cwdRel: "api" });
    expect(workspaceForFolder(workspaces, "C:\\src\\billing\\web", true)).toEqual({ workspaceId: "a", cwdRel: "billing/web" });
    expect(workspaceForFolder(workspaces, "D:\\other", true)).toBeNull();
    expect(workspaceForFolder(workspaces, "C:\\srcx", true)).toBeNull();
  });

  it("is case-sensitive off Windows", () => {
    expect(workspaceForFolder([{ id: "u", path: "/home/me/App" }], "/home/me/app", false)).toBeNull();
    expect(workspaceForFolder([{ id: "u", path: "/home/me/App" }], "/home/me/App/src", false)).toEqual({ workspaceId: "u", cwdRel: "src" });
  });
});

describe("filterSessions / groupSessions", () => {
  const rows = [
    row({ sessionId: "1", agent: "codex", model: "gpt-5.5-codex" }),
    row({ sessionId: "2" }),
    row({ sessionId: "3", projectRoot: "C:\\src\\billing", projectName: "billing" }),
  ];

  it("matches every word against project, folder, model, agent name and id", () => {
    expect(filterSessions(rows, "codex orders", names).map((r) => r.sessionId)).toEqual(["1"]);
    expect(filterSessions(rows, "claude billing", names).map((r) => r.sessionId)).toEqual(["3"]);
    expect(filterSessions(rows, "  ", names)).toHaveLength(3);
  });

  it("groups by project or agent in order of the newest row", () => {
    expect(groupSessions(rows, "project", names).map((g) => [g.label, g.rows.length])).toEqual([
      ["orders-service", 2],
      ["billing", 1],
    ]);
    expect(groupSessions(rows, "agent", names).map((g) => g.label)).toEqual(["Codex", "Claude Code"]);
    expect(groupSessions(rows, "none", names)).toHaveLength(1);
    expect(groupSessions([], "none", names)).toEqual([]);
  });
});
