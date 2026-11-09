import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocsReport } from "../lib/ipc";

const ipc = vi.hoisted(() => ({
  docsCheck: vi.fn(),
  docsMarkReviewed: vi.fn(),
  fsHandlers: [] as ((p: { workspaceId: string; dirs: string[] }) => void)[],
  rescanHandlers: [] as ((p: { workspaceId: string }) => void)[],
}));

vi.mock("../lib/ipc", () => ({
  docsCheck: ipc.docsCheck,
  docsMarkReviewed: ipc.docsMarkReviewed,
  toAppError: (e: unknown) => e,
  onFsChanged: (h: (p: { workspaceId: string; dirs: string[] }) => void) => {
    ipc.fsHandlers.push(h);
    return Promise.resolve(() => {});
  },
  onFsRescan: (h: (p: { workspaceId: string }) => void) => {
    ipc.rescanHandlers.push(h);
    return Promise.resolve(() => {});
  },
}));

import { DOCS_DEBOUNCE_MS, docsRelevantDirs, resetDocsStoreForTests, useDocsStore } from "./docsStore";

const report: DocsReport = {
  root: "C:\\src\\demo",
  gitAvailable: true,
  head: "a".repeat(40),
  configPath: null,
  configError: null,
  docs: [],
  truncated: false,
  summary: { docs: 3, stale: 0, missing: 0 },
};
const fsChanged = (workspaceId: string, dirs = ["docs"]) => ipc.fsHandlers.forEach((h) => h({ workspaceId, dirs }));

beforeEach(() => {
  vi.useFakeTimers();
  resetDocsStoreForTests();
  ipc.docsCheck.mockReset().mockResolvedValue(report);
  ipc.docsMarkReviewed.mockReset().mockResolvedValue({ commit: "a".repeat(40) });
  ipc.fsHandlers.length = 0;
  ipc.rescanHandlers.length = 0;
});

afterEach(() => vi.useRealTimers());

describe("docsStore", () => {
  it("loads on the first watch only and refreshes once per burst of file events", async () => {
    const unwatchA = useDocsStore.getState().watch("ws");
    const unwatchB = useDocsStore.getState().watch("ws");
    await vi.waitFor(() => expect(useDocsStore.getState().byWorkspace.ws?.status).toBe("ready"));
    expect(ipc.docsCheck).toHaveBeenCalledTimes(1);
    expect(useDocsStore.getState().byWorkspace.ws?.report).toEqual(report);

    fsChanged("ws");
    await vi.advanceTimersByTimeAsync(DOCS_DEBOUNCE_MS - 100);
    fsChanged("ws", ["src"]);
    fsChanged("other");
    expect(ipc.docsCheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DOCS_DEBOUNCE_MS + 10);
    expect(ipc.docsCheck).toHaveBeenCalledTimes(2);
    expect(ipc.docsCheck).toHaveBeenLastCalledWith("ws");

    // fs:rescan counts too.
    ipc.rescanHandlers.forEach((h) => h({ workspaceId: "ws" }));
    await vi.advanceTimersByTimeAsync(DOCS_DEBOUNCE_MS + 10);
    expect(ipc.docsCheck).toHaveBeenCalledTimes(3);

    unwatchA();
    unwatchB();
    fsChanged("ws");
    await vi.advanceTimersByTimeAsync(DOCS_DEBOUNCE_MS + 10);
    expect(ipc.docsCheck).toHaveBeenCalledTimes(3);
  });

  it("ignores changes inside worktree folders", async () => {
    useDocsStore.getState().watch("ws");
    await vi.waitFor(() => expect(useDocsStore.getState().byWorkspace.ws?.status).toBe("ready"));
    fsChanged("ws", [".kotilo/worktrees/fix/src", ".kotilo/worktrees"]);
    await vi.advanceTimersByTimeAsync(DOCS_DEBOUNCE_MS + 10);
    expect(ipc.docsCheck).toHaveBeenCalledTimes(1);
    expect(docsRelevantDirs([".kotilo"])).toBe(true);
    expect(docsRelevantDirs([""])).toBe(true);
    expect(docsRelevantDirs([".kotilo/worktrees/a"])).toBe(false);
  });

  it("keeps the last report and the error when a check fails", async () => {
    await useDocsStore.getState().refresh("ws");
    ipc.docsCheck.mockRejectedValueOnce({ code: "io", message: "git failed" });
    await useDocsStore.getState().refresh("ws");
    expect(useDocsStore.getState().byWorkspace.ws).toEqual({ status: "error", report, error: { code: "io", message: "git failed" } });
  });

  it("a refresh requested while one runs reruns once afterwards", async () => {
    let release = () => {};
    ipc.docsCheck.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(report))));
    const first = useDocsStore.getState().refresh("ws");
    const second = useDocsStore.getState().refresh("ws");
    void useDocsStore.getState().refresh("ws");
    expect(useDocsStore.getState().byWorkspace.ws?.status).toBe("loading");
    release();
    await first;
    await second;
    expect(ipc.docsCheck).toHaveBeenCalledTimes(2);
  });

  it("keeps the tab's filter and expanded rows per workspace", () => {
    const st = useDocsStore.getState();
    st.setFilter("ws", "stale");
    st.toggleExpanded("ws", "a.md");
    st.toggleExpanded("ws", "b.md");
    st.toggleExpanded("ws", "a.md");
    expect(useDocsStore.getState().view).toEqual({ ws: { filter: "stale", expanded: ["b.md"] } });
  });

  it("markReviewed writes, then re-checks; an error is returned and nothing is re-checked", async () => {
    expect(await useDocsStore.getState().markReviewed("ws", "docs/api.md")).toBeNull();
    expect(ipc.docsMarkReviewed).toHaveBeenCalledWith("ws", "docs/api.md");
    expect(ipc.docsCheck).toHaveBeenCalledTimes(1);

    ipc.docsMarkReviewed.mockRejectedValueOnce({ code: "invalid_config", message: "line 3: expected =" });
    expect(await useDocsStore.getState().markReviewed("ws", "docs/api.md")).toEqual({ code: "invalid_config", message: "line 3: expected =" });
    expect(ipc.docsCheck).toHaveBeenCalledTimes(1);
  });
});
