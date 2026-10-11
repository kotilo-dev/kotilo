import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitChanges } from "../../lib/ipc";

const ipc = vi.hoisted(() => ({
  gitChanges: vi.fn(),
  fsHandlers: [] as ((p: { workspaceId: string; dirs: string[] }) => void)[],
}));

vi.mock("../../lib/ipc", () => ({
  gitChanges: ipc.gitChanges,
  onFsChanged: (h: (p: { workspaceId: string; dirs: string[] }) => void) => {
    ipc.fsHandlers.push(h);
    return Promise.resolve(() => {});
  },
  onFsRescan: () => Promise.resolve(() => {}),
}));

import { CHANGES_DEBOUNCE_MS, resetChangesStoreForTests, useChangesStore } from "./changesStore";

const changes: GitChanges = { repo: true, head: "abc", files: [{ path: "a.ts", status: "M", added: 1, removed: 2 }], truncated: false };
const fsChanged = (workspaceId: string) => ipc.fsHandlers.forEach((h) => h({ workspaceId, dirs: [""] }));

beforeEach(() => {
  vi.useFakeTimers();
  resetChangesStoreForTests();
  ipc.gitChanges.mockReset().mockResolvedValue(changes);
  ipc.fsHandlers.length = 0;
});

afterEach(() => vi.useRealTimers());

describe("changesStore", () => {
  it("loads on watch and refreshes once per burst of file events", async () => {
    const unwatch = useChangesStore.getState().watch("ws");
    await vi.waitFor(() => expect(useChangesStore.getState().byWorkspace.ws?.status).toBe("ready"));
    expect(useChangesStore.getState().byWorkspace.ws?.changes).toEqual(changes);

    fsChanged("ws");
    fsChanged("ws");
    fsChanged("other");
    await vi.advanceTimersByTimeAsync(CHANGES_DEBOUNCE_MS + 10);
    expect(ipc.gitChanges).toHaveBeenCalledTimes(2);

    unwatch();
    fsChanged("ws");
    await vi.advanceTimersByTimeAsync(CHANGES_DEBOUNCE_MS + 10);
    expect(ipc.gitChanges).toHaveBeenCalledTimes(2);
  });

  it("reports an error state when git_changes rejects", async () => {
    ipc.gitChanges.mockRejectedValue({ code: "not_found", message: "x" });
    useChangesStore.getState().watch("ws");
    await vi.waitFor(() => expect(useChangesStore.getState().byWorkspace.ws?.status).toBe("error"));
  });
});
