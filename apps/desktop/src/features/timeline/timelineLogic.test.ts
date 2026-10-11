import { describe, expect, it } from "vitest";
import type { ActivityEntry, ActivityToolEntry } from "../../lib/hubTypes";
import type { Agent, GitChangedFile } from "../../lib/ipc";
import { makeSession } from "../workspace/sessionFixture";
import {
  ACTIVITY_RING,
  applyFrame,
  applySnapshot,
  formatToolDuration,
  groupChangedFiles,
  mergeEntries,
  planProgress,
  selectTimelineSession,
  toolLetter,
  toolTone,
  touchedPaths,
} from "./timelineLogic";

function tool(id: number, partial: Partial<ActivityToolEntry> = {}): ActivityToolEntry {
  return { id, kind: "read", tool: "Read", target: `f${id}.ts`, startedAt: "2026-10-08T10:00:00Z", status: "ok", ...partial };
}

const turn = (id: number): ActivityEntry => ({ id, kind: "turn", at: "2026-10-08T10:00:00Z" });

describe("mergeEntries", () => {
  it("merges by id, replaces changed entries and keeps id order", () => {
    const current = [tool(1), tool(2, { status: "running" })];
    const merged = mergeEntries(current, [tool(3), tool(2, { status: "ok", durationMs: 40 })]);
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(merged[1]).toMatchObject({ status: "ok", durationMs: 40 });
  });

  it("never turns a finished entry back into running (stale full fetch)", () => {
    const merged = mergeEntries([tool(5, { status: "failed" })], [tool(5, { status: "running" })]);
    expect(merged[0]).toMatchObject({ status: "failed" });
  });

  it("keeps the last 200 entries", () => {
    const many = Array.from({ length: ACTIVITY_RING + 15 }, (_, i) => tool(i + 1));
    const merged = mergeEntries([], many);
    expect(merged).toHaveLength(ACTIVITY_RING);
    expect(merged[0]!.id).toBe(16);
  });

  it("returns the same array for an empty delta", () => {
    const current = [tool(1)];
    expect(mergeEntries(current, [])).toBe(current);
  });
});

describe("frames and snapshots", () => {
  const plan = { items: [{ text: "a", status: "completed" as const }] };

  it("a frame merges entries and replaces the plan", () => {
    const next = applyFrame({ entries: [tool(1)], plan: null }, { agent: "claude-code", sessionId: "s", entries: [turn(2)], plan });
    expect(next.entries.map((e) => e.id)).toEqual([1, 2]);
    expect(next.plan).toBe(plan);
  });

  it("a snapshot keeps the stream's plan when a frame arrived during the fetch", () => {
    const fromStream = { entries: [tool(3)], plan };
    expect(applySnapshot(fromStream, { entries: [tool(1), tool(2)], plan: null }, true)).toEqual({
      entries: [tool(1), tool(2), tool(3)],
      plan,
    });
    expect(applySnapshot(fromStream, { entries: [], plan: null }, false).plan).toBeNull();
  });
});

describe("plan", () => {
  it("counts completed items", () => {
    expect(
      planProgress({
        items: [
          { text: "a", status: "completed" },
          { text: "b", status: "in_progress" },
          { text: "c", status: "pending" },
        ],
      }),
    ).toEqual({ done: 1, total: 3, percent: 33 });
  });

  it("is null without items", () => {
    expect(planProgress(null)).toBeNull();
    expect(planProgress({ items: [] })).toBeNull();
  });
});

describe("activity rows", () => {
  it("maps kinds to the DESIGN_SYSTEM §5 letters", () => {
    expect(toolLetter(tool(1, { kind: "read" }))).toBe("R");
    expect(toolLetter(tool(1, { kind: "edit", tool: "Edit" }))).toBe("E");
    expect(toolLetter(tool(1, { kind: "write", tool: "Write" }))).toBe("E");
    expect(toolLetter(tool(1, { kind: "bash", tool: "Bash" }))).toBe("B");
    expect(toolLetter(tool(1, { kind: "task", tool: "Task" }))).toBe("T");
    expect(toolLetter(tool(1, { kind: "search", tool: "WebFetch" }))).toBe("W");
    expect(toolLetter(tool(1, { kind: "search", tool: "Grep" }))).toBe("S");
    expect(toolLetter(tool(1, { kind: "other", tool: "mcp__github__x" }))).toBe("M");
  });

  it("colours running, failed/denied and edits", () => {
    expect(toolTone(tool(1, { status: "running", kind: "edit" }))).toBe("running");
    expect(toolTone(tool(1, { status: "failed" }))).toBe("failed");
    expect(toolTone(tool(1, { status: "denied" }))).toBe("failed");
    expect(toolTone(tool(1, { kind: "write" }))).toBe("edit");
    expect(toolTone(tool(1, { kind: "bash" }))).toBe("neutral");
  });

  it("formats durations", () => {
    expect(formatToolDuration(320)).toBe("320 ms");
    expect(formatToolDuration(4200)).toBe("4.2 s");
    expect(formatToolDuration(65_000)).toBe("1m 05s");
  });
});

describe("changed files", () => {
  const files: GitChangedFile[] = [
    { path: "README.md", status: "M", added: 1, removed: 0 },
    { path: "src/approval.ts", status: "M", added: 12, removed: 3 },
    { path: "src/new.ts", status: "?", added: 5, removed: 0 },
    { path: "src/renamed.ts", status: "R", added: 0, removed: 0, oldPath: "src/old.ts" },
  ];

  it("collects edit/write targets relative to the workspace", () => {
    const entries: ActivityEntry[] = [
      tool(1, { kind: "edit", tool: "Edit", target: "src/Approval.ts" }),
      tool(2, { kind: "read", target: "README.md" }),
      tool(3, { kind: "write", tool: "Write", target: "C:\\src\\orders-service\\src\\new.ts" }),
      tool(4, { kind: "edit", tool: "apply_patch", target: "x", paths: ["src/old.ts"] }),
      tool(5, { kind: "edit", tool: "Edit", target: "D:/elsewhere/file.ts" }),
      turn(6),
    ];
    const touched = touchedPaths(entries, "C:\\src\\orders-service", "C:\\src\\orders-service");
    expect([...touched].sort()).toEqual(["src/approval.ts", "src/new.ts", "src/old.ts", "x"]);
  });

  it("resolves targets of a project that is a subfolder of the workspace", () => {
    const touched = touchedPaths([tool(1, { kind: "edit", target: "lib/a.ts" })], "C:/repo", "C:/repo/packages/core");
    expect([...touched]).toEqual(["packages/core/lib/a.ts"]);
  });

  it("puts touched files first, the rest under other changes (renames match the old path)", () => {
    const groups = groupChangedFiles(files, new Set(["src/approval.ts", "src/old.ts"]));
    expect(groups.touched.map((f) => f.path)).toEqual(["src/approval.ts", "src/renamed.ts"]);
    expect(groups.other.map((f) => f.path)).toEqual(["README.md", "src/new.ts"]);
  });
});

describe("selectTimelineSession", () => {
  const agent: Agent = { id: "a", paneId: "pane-1", workspaceId: "ws", kind: "codex", adapterId: "codex", state: "working", sinceMs: 0, source: "hook", sessionId: "codex-1" };

  it("prefers the active pane's session", () => {
    const sessions = [
      makeSession({ sessionId: "other", projectRoot: "C:/src/app", lastEventAt: "2026-10-08T10:05:00Z" }),
      makeSession({ sessionId: "mine", paneId: "pane-1" }),
    ];
    expect(selectTimelineSession(sessions, [], "pane-1", "C:\\src\\app")?.sessionId).toBe("mine");
  });

  it("falls back to the desktop record's session id (Codex without pane env)", () => {
    const sessions = [makeSession({ sessionId: "codex-1", agent: "codex" })];
    expect(selectTimelineSession(sessions, [agent], "pane-1", null)?.sessionId).toBe("codex-1");
  });

  it("otherwise picks the latest live session of the workspace folder", () => {
    const sessions = [
      makeSession({ sessionId: "old", projectRoot: "C:\\src\\app", lastEventAt: "2026-10-08T09:00:00Z" }),
      makeSession({ sessionId: "new", projectRoot: "c:/src/app/", lastEventAt: "2026-10-08T10:00:00Z" }),
      makeSession({ sessionId: "ended", projectRoot: "C:/src/app", state: "Ended", lastEventAt: "2026-10-08T11:00:00Z" }),
      makeSession({ sessionId: "elsewhere", projectRoot: "C:/src/other", lastEventAt: "2026-10-08T12:00:00Z" }),
    ];
    expect(selectTimelineSession(sessions, [], null, "C:\\src\\app")?.sessionId).toBe("new");
    expect(selectTimelineSession(sessions, [], null, "C:\\src\\none")).toBeNull();
  });
});
