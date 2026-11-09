import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeList } from "../lib/ipc";

const ipc = vi.hoisted(() => ({
  worktreeList: vi.fn(),
  fsHandlers: [] as ((p: { workspaceId: string; dirs: string[] }) => void)[],
}));

vi.mock("../lib/ipc", () => ({
  worktreeList: ipc.worktreeList,
  onFsChanged: (h: (p: { workspaceId: string; dirs: string[] }) => void) => {
    ipc.fsHandlers.push(h);
    return Promise.resolve(() => {});
  },
  onFsRescan: () => Promise.resolve(() => {}),
}));

import { WORKTREES_DEBOUNCE_MS, resetWorktreeStoreForTests, useWorktreeStore } from "./worktreeStore";

const list: WorktreeList = { supported: true, reason: null, currentBranch: "main", mainDirty: false, worktrees: [] };
const fsChanged = (workspaceId: string) => ipc.fsHandlers.forEach((h) => h({ workspaceId, dirs: [".kotilo/worktrees/x/src"] }));

beforeEach(() => {
  vi.useFakeTimers();
  resetWorktreeStoreForTests();
  ipc.worktreeList.mockReset().mockResolvedValue(list);
  ipc.fsHandlers.length = 0;
});

afterEach(() => vi.useRealTimers());

describe("worktreeStore", () => {
  it("loads on watch and refreshes once per burst of file events", async () => {
    const unwatch = useWorktreeStore.getState().watch("ws");
    await vi.waitFor(() => expect(useWorktreeStore.getState().byWorkspace.ws?.status).toBe("ready"));
    expect(ipc.worktreeList).toHaveBeenCalledTimes(1);

    fsChanged("ws");
    fsChanged("ws");
    fsChanged("other");
    await vi.advanceTimersByTimeAsync(WORKTREES_DEBOUNCE_MS + 10);
    expect(ipc.worktreeList).toHaveBeenCalledTimes(2);
    expect(ipc.worktreeList).toHaveBeenLastCalledWith("ws");

    unwatch();
    fsChanged("ws");
    await vi.advanceTimersByTimeAsync(WORKTREES_DEBOUNCE_MS + 10);
    expect(ipc.worktreeList).toHaveBeenCalledTimes(2);
  });

  it("ensure loads only once and keeps the last list on an error", async () => {
    useWorktreeStore.getState().ensure("ws");
    useWorktreeStore.getState().ensure("ws");
    await vi.waitFor(() => expect(useWorktreeStore.getState().byWorkspace.ws?.status).toBe("ready"));
    useWorktreeStore.getState().ensure("ws");
    expect(ipc.worktreeList).toHaveBeenCalledTimes(1);

    ipc.worktreeList.mockRejectedValueOnce({ code: "io", message: "x" });
    await useWorktreeStore.getState().refresh("ws");
    expect(useWorktreeStore.getState().byWorkspace.ws).toEqual({ status: "error", list });
  });

  it("holds one dialog at a time", () => {
    useWorktreeStore.getState().openDialog({ kind: "merge", workspaceId: "ws", name: "x" });
    useWorktreeStore.getState().openDialog({ kind: "remove", workspaceId: "ws", name: "x" });
    expect(useWorktreeStore.getState().dialog).toEqual({ kind: "remove", workspaceId: "ws", name: "x" });
    useWorktreeStore.getState().closeDialog();
    expect(useWorktreeStore.getState().dialog).toBeNull();
  });
});
