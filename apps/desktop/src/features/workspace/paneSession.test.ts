import { describe, expect, it } from "vitest";
import type { Agent } from "../../lib/ipc";
import { matchSession, paneVisualState, statusFamily } from "./paneSession";
import { makeSession } from "./sessionFixture";

function agent(partial: Partial<Agent>): Agent {
  return { id: "p1", paneId: "p1", workspaceId: "w", kind: "claude", state: "idle", sinceMs: 0, source: "hook", sessionId: null, ...partial };
}

describe("matchSession", () => {
  it("prefers the session that carries the pane id, newest first", () => {
    const older = makeSession({ sessionId: "a", paneId: "p1", lastEventAt: "2026-10-04T09:00:00Z" });
    const newer = makeSession({ sessionId: "b", paneId: "p1", lastEventAt: "2026-10-04T10:00:00Z" });
    expect(matchSession([older, newer], "p1", undefined)?.sessionId).toBe("b");
  });

  it("falls back to the desktop record's session id and adapter id (Codex has no pane id)", () => {
    const codex = makeSession({ sessionId: "cx", agent: "codex" });
    const claudeSameId = makeSession({ sessionId: "cx", agent: "claude-code" });
    const found = matchSession([claudeSameId, codex], "p9", agent({ paneId: "p9", kind: "codex", adapterId: "codex", sessionId: "cx" }));
    expect(found).toBe(codex);
  });

  it("ignores ended sessions and returns null without a link", () => {
    expect(matchSession([makeSession({ paneId: "p1", state: "Ended" })], "p1", undefined)).toBeNull();
    expect(matchSession([makeSession({ sessionId: "x" })], "p1", agent({ sessionId: null }))).toBeNull();
  });
});

describe("paneVisualState", () => {
  it("maps hub session states", () => {
    expect(paneVisualState(makeSession({ state: "WaitingPermission" }), undefined)).toBe("permission");
    expect(paneVisualState(makeSession({ state: "WaitingInput" }), undefined)).toBe("input");
    expect(paneVisualState(makeSession({ state: "Working" }), undefined)).toBe("working");
    expect(paneVisualState(makeSession({ state: "Error" }), undefined)).toBe("error");
  });

  it("keeps the desktop's unseen done over a hub Idle", () => {
    expect(paneVisualState(makeSession({ state: "Idle" }), agent({ state: "done" }))).toBe("done");
    expect(paneVisualState(makeSession({ state: "Idle" }), agent({ state: "idle" }))).toBe("idle");
  });

  it("shows the hub's unseen finished work as done, with or without a pane record (D-056)", () => {
    expect(paneVisualState(makeSession({ state: "Idle", unseen: true }), undefined)).toBe("done");
    expect(paneVisualState(makeSession({ state: "Idle", unseen: true }), agent({ state: "idle" }))).toBe("done");
    expect(paneVisualState(makeSession({ state: "Idle", unseen: false }), undefined)).toBe("idle");
  });

  it("falls back to the desktop record, and is null without any agent", () => {
    expect(paneVisualState(null, agent({ state: "blocked" }))).toBe("permission");
    expect(paneVisualState(null, undefined)).toBeNull();
  });

  it("lets a screen-detected permission prompt win over the hub's Working (Cursor)", () => {
    const working = makeSession({ state: "Working" });
    expect(paneVisualState(working, agent({ state: "blocked" }), true)).toBe("permission");
    // Without a screen rule the hub stays the source.
    expect(paneVisualState(working, agent({ state: "blocked" }), false)).toBe("working");
    expect(paneVisualState(working, agent({ state: "working" }), true)).toBe("working");
    expect(paneVisualState(makeSession({ state: "WaitingInput" }), agent({ state: "blocked" }), true)).toBe("input");
  });

  it("groups waiting states into the blocked color family", () => {
    expect(statusFamily("permission")).toBe("blocked");
    expect(statusFamily("input")).toBe("blocked");
    expect(statusFamily("done")).toBe("done");
  });
});
