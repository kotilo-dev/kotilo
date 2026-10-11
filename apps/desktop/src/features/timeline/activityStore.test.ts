import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityDto, StreamMessage } from "../../lib/hubTypes";

const ipc = vi.hoisted(() => ({
  hubRequest: vi.fn(),
  hubHandlers: [] as ((m: unknown) => void)[],
  statusHandlers: [] as ((s: { connected: boolean }) => void)[],
}));

vi.mock("../../lib/ipc", () => ({
  hubRequest: ipc.hubRequest,
  onHubEvent: (h: (m: unknown) => void) => {
    ipc.hubHandlers.push(h);
    return Promise.resolve(() => {});
  },
  onHubStatus: (h: (s: { connected: boolean }) => void) => {
    ipc.statusHandlers.push(h);
    return Promise.resolve(() => {});
  },
}));

import { resetActivityStoreForTests, useActivityStore } from "./activityStore";

const ref = { agent: "claude-code", sessionId: "s1" };
const key = "claude-code/s1";
const emit = (m: StreamMessage) => ipc.hubHandlers.forEach((h) => h(m));
const tool = (id: number, status: "running" | "ok" = "ok") => ({ id, kind: "bash" as const, tool: "Bash", startedAt: "2026-10-08T10:00:00Z", status });

beforeEach(() => {
  resetActivityStoreForTests();
  ipc.hubRequest.mockReset();
  ipc.hubHandlers.length = 0;
  ipc.statusHandlers.length = 0;
});

describe("activityStore", () => {
  it("fetches a session once and merges stream deltas afterwards", async () => {
    ipc.hubRequest.mockResolvedValue({ entries: [tool(1)], plan: null } satisfies ActivityDto);
    await useActivityStore.getState().ensure(ref);
    await useActivityStore.getState().ensure(ref);
    expect(ipc.hubRequest).toHaveBeenCalledTimes(1);
    expect(ipc.hubRequest).toHaveBeenCalledWith("GET", "/v1/sessions/claude-code/s1/activity");

    emit({ type: "activity", data: { agent: "claude-code", sessionId: "s1", entries: [tool(2, "running")], plan: { items: [{ text: "x", status: "pending" }] } } });
    const s = useActivityStore.getState().bySession[key]!;
    expect(s.status).toBe("ready");
    expect(s.entries.map((e) => e.id)).toEqual([1, 2]);
    expect(s.plan?.items).toHaveLength(1);
  });

  it("ignores frames of sessions nobody asked for", async () => {
    ipc.hubRequest.mockResolvedValue({ entries: [], plan: null });
    await useActivityStore.getState().ensure(ref);
    emit({ type: "activity", data: { agent: "codex", sessionId: "other", entries: [tool(9)], plan: null } });
    expect(Object.keys(useActivityStore.getState().bySession)).toEqual([key]);
  });

  it("keeps a frame that arrives while the fetch is in flight", async () => {
    let resolve!: (dto: ActivityDto) => void;
    ipc.hubRequest.mockReturnValue(new Promise<ActivityDto>((r) => (resolve = r)));
    const pending = useActivityStore.getState().ensure(ref);
    const plan = { items: [{ text: "new", status: "in_progress" as const }] };
    emit({ type: "activity", data: { agent: "claude-code", sessionId: "s1", entries: [tool(3)], plan } });
    resolve({ entries: [tool(1), tool(3, "running")], plan: null });
    await pending;
    const s = useActivityStore.getState().bySession[key]!;
    expect(s.entries).toEqual([tool(1), tool(3)]);
    expect(s.plan).toEqual(plan);
  });

  it("treats a failed fetch (unknown session) as empty", async () => {
    ipc.hubRequest.mockRejectedValue({ code: "not_found", message: "x" });
    await useActivityStore.getState().ensure(ref);
    expect(useActivityStore.getState().bySession[key]).toMatchObject({ status: "ready", entries: [], plan: null });
  });

  it("re-fetches tracked sessions after a reconnect", async () => {
    ipc.hubRequest.mockResolvedValue({ entries: [], plan: null });
    await useActivityStore.getState().ensure(ref);
    ipc.statusHandlers.forEach((h) => h({ connected: true }));
    await vi.waitFor(() => expect(ipc.hubRequest).toHaveBeenCalledTimes(2));
    // A repeated "connected" is not a reconnect.
    ipc.statusHandlers.forEach((h) => h({ connected: true }));
    await Promise.resolve();
    expect(ipc.hubRequest).toHaveBeenCalledTimes(2);
    ipc.statusHandlers.forEach((h) => h({ connected: false }));
    ipc.statusHandlers.forEach((h) => h({ connected: true }));
    await vi.waitFor(() => expect(ipc.hubRequest).toHaveBeenCalledTimes(3));
  });
});
