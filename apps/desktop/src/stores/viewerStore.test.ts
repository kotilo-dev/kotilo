import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspacesState } from "../lib/ipc";

const ipc = vi.hoisted(() => ({
  loadState: vi.fn(),
  saveStateSlice: vi.fn(),
  workspaceList: vi.fn(),
  fsStat: vi.fn(),
  fsExists: vi.fn(),
  fsReadText: vi.fn(),
  fsWriteText: vi.fn(),
  onFsChanged: vi.fn(),
  onFsRescan: vi.fn(),
  onWorkspacesChanged: vi.fn(),
}));

vi.mock("../lib/ipc", () => ipc);

let fsChangedHandler: ((p: { workspaceId: string; dirs: string[] }) => void) | undefined;
let fsRescanHandler: ((p: { workspaceId: string }) => void) | undefined;
let workspacesChangedHandler: ((p: WorkspacesState) => void) | undefined;

async function freshStore() {
  vi.resetModules();
  fsChangedHandler = undefined;
  fsRescanHandler = undefined;
  workspacesChangedHandler = undefined;

  ipc.onFsChanged.mockImplementation((h: typeof fsChangedHandler) => {
    fsChangedHandler = h;
    return Promise.resolve(() => {});
  });
  ipc.onFsRescan.mockImplementation((h: typeof fsRescanHandler) => {
    fsRescanHandler = h;
    return Promise.resolve(() => {});
  });
  ipc.onWorkspacesChanged.mockImplementation((h: typeof workspacesChangedHandler) => {
    workspacesChangedHandler = h;
    return Promise.resolve(() => {});
  });

  const viewerMod = await import("./viewerStore");
  const docMod = await import("./documentStore");
  return { ...viewerMod, ...docMod };
}

beforeEach(() => {
  Object.values(ipc).forEach((fn) => {
    if (typeof fn === "function" && "mockReset" in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  });
  ipc.loadState.mockResolvedValue({});
  ipc.saveStateSlice.mockResolvedValue(undefined);
  ipc.workspaceList.mockResolvedValue({ workspaces: [{ id: "ws1", name: "ws1", path: "C:\\ws1", expandedDirs: [] }], activeId: "ws1" });
  ipc.fsStat.mockResolvedValue({ size: 1, mtimeMs: 1, hash: "h" });
  ipc.fsExists.mockResolvedValue(true);
});

function tabsOf(store: Awaited<ReturnType<typeof freshStore>>, workspaceId: string) {
  return store.useViewerStore.getState().byWorkspace[workspaceId]?.tabs ?? [];
}

function activeRelOf(store: Awaited<ReturnType<typeof freshStore>>, workspaceId: string) {
  const ws = store.useViewerStore.getState().byWorkspace[workspaceId];
  return ws?.tabs.find((t) => t.id === ws.activeTabId)?.rel;
}

describe("preview vs. pinned rules", () => {
  it("a single click ({pinned:false}) on a new file opens (or replaces) the one preview tab", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();

    store.useViewerStore.getState().openFile("ws1", "a.txt", { pinned: false });
    expect(tabsOf(store, "ws1")).toHaveLength(1);
    expect(tabsOf(store, "ws1")[0]).toMatchObject({ rel: "a.txt", pinned: false });

    store.useViewerStore.getState().openFile("ws1", "b.txt", { pinned: false });
    const tabs = tabsOf(store, "ws1");
    expect(tabs).toHaveLength(1); // replaced, not appended
    expect(tabs[0]).toMatchObject({ rel: "b.txt", pinned: false });
  });

  it("double click ({pinned:true}) opens a permanent tab alongside an existing preview tab", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();

    store.useViewerStore.getState().openFile("ws1", "a.txt", { pinned: false });
    store.useViewerStore.getState().openFile("ws1", "b.txt", { pinned: true });

    const tabs = tabsOf(store, "ws1");
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t) => t.rel === "a.txt")).toMatchObject({ pinned: false });
    expect(tabs.find((t) => t.rel === "b.txt")).toMatchObject({ pinned: true });
  });

  it("a dirty preview tab is pinned in place instead of being replaced", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();

    store.useViewerStore.getState().openFile("ws1", "a.txt", { pinned: false });
    // Simulate a's document being dirty.
    store.useDocumentStore.setState({
      docs: {
        [store.docKey("ws1", "a.txt")]: {
          status: "ready",
          text: "changed",
          savedText: "orig",
          encoding: "utf8",
          eol: "lf",
          mixedEol: false,
          hash: "h",
          readOnly: false,
          readOnlyReason: null,
          dirty: true,
          external: null,
        },
      },
    });

    store.useViewerStore.getState().openFile("ws1", "b.txt", { pinned: false });

    const tabs = tabsOf(store, "ws1");
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t) => t.rel === "a.txt")).toMatchObject({ pinned: true }); // promoted, not closed
    expect(tabs.find((t) => t.rel === "b.txt")).toMatchObject({ pinned: false }); // new preview
    expect(activeRelOf(store, "ws1")).toBe("b.txt");
  });

  it("opening an already-open tab with a single click just activates it, never un-pins it", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();

    store.useViewerStore.getState().openFile("ws1", "a.txt", { pinned: true });
    store.useViewerStore.getState().openFile("ws1", "b.txt", { pinned: false });
    // Single click back on the already-pinned "a.txt".
    store.useViewerStore.getState().openFile("ws1", "a.txt", { pinned: false });

    const tabs = tabsOf(store, "ws1");
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t) => t.rel === "a.txt")).toMatchObject({ pinned: true });
    expect(activeRelOf(store, "ws1")).toBe("a.txt");
  });

  it("double-clicking an existing preview tab pins it in place", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();

    store.useViewerStore.getState().openFile("ws1", "a.txt", { pinned: false });
    store.useViewerStore.getState().openFile("ws1", "a.txt", { pinned: true });

    const tabs = tabsOf(store, "ws1");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ rel: "a.txt", pinned: true });
  });

  it("markdown/html/svg default to preview mode; plain text has no mode", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();

    store.useViewerStore.getState().openFile("ws1", "readme.md", { pinned: true });
    store.useViewerStore.getState().openFile("ws1", "page.html", { pinned: true });
    store.useViewerStore.getState().openFile("ws1", "icon.svg", { pinned: true });
    store.useViewerStore.getState().openFile("ws1", "a.txt", { pinned: true });

    const tabs = tabsOf(store, "ws1");
    expect(tabs.find((t) => t.rel === "readme.md")?.mode).toBe("preview");
    expect(tabs.find((t) => t.rel === "page.html")?.mode).toBe("preview");
    expect(tabs.find((t) => t.rel === "icon.svg")?.mode).toBe("preview");
    expect(tabs.find((t) => t.rel === "a.txt")?.mode).toBeUndefined();
  });
});

describe("closeTab", () => {
  it("closing the active tab activates a neighbor", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();
    store.useViewerStore.getState().openFile("ws1", "a.txt", { pinned: true });
    store.useViewerStore.getState().openFile("ws1", "b.txt", { pinned: true });
    store.useViewerStore.getState().openFile("ws1", "c.txt", { pinned: true });
    expect(activeRelOf(store, "ws1")).toBe("c.txt");

    const bTab = tabsOf(store, "ws1").find((t) => t.rel === "b.txt")!;
    store.useViewerStore.getState().activate("ws1", bTab.id);
    store.useViewerStore.getState().closeTab("ws1", bTab.id);

    expect(tabsOf(store, "ws1").map((t) => t.rel)).toEqual(["a.txt", "c.txt"]);
    expect(activeRelOf(store, "ws1")).toBe("c.txt");
  });
});

describe("retarget", () => {
  it("renames a single tab's rel and rekeys its document", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();
    store.useViewerStore.getState().openFile("ws1", "old.txt", { pinned: true });
    store.useDocumentStore.setState({
      docs: {
        [store.docKey("ws1", "old.txt")]: {
          status: "ready",
          text: "x",
          savedText: "x",
          encoding: "utf8",
          eol: "lf",
          mixedEol: false,
          hash: "h",
          readOnly: false,
          readOnlyReason: null,
          dirty: false,
          external: null,
        },
      },
    });

    store.useViewerStore.getState().retarget("ws1", "old.txt", "new.txt");

    expect(tabsOf(store, "ws1").map((t) => t.rel)).toEqual(["new.txt"]);
    expect(store.useDocumentStore.getState().docs[store.docKey("ws1", "old.txt")]).toBeUndefined();
    expect(store.useDocumentStore.getState().docs[store.docKey("ws1", "new.txt")]).toBeDefined();
  });

  it("renames a folder prefix, moving every descendant tab", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();
    store.useViewerStore.getState().openFile("ws1", "old/a.txt", { pinned: true });
    store.useViewerStore.getState().openFile("ws1", "old/nested/b.txt", { pinned: true });
    store.useViewerStore.getState().openFile("ws1", "unrelated.txt", { pinned: true });

    store.useViewerStore.getState().retarget("ws1", "old", "renamed");

    expect(tabsOf(store, "ws1").map((t) => t.rel).sort()).toEqual(
      ["renamed/a.txt", "renamed/nested/b.txt", "unrelated.txt"].sort(),
    );
  });

  it("does not close tabs (own rename should not look like an external delete)", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();
    store.useViewerStore.getState().openFile("ws1", "old.txt", { pinned: true });
    const before = tabsOf(store, "ws1").length;

    store.useViewerStore.getState().retarget("ws1", "old.txt", "new.txt");

    expect(tabsOf(store, "ws1")).toHaveLength(before);
  });

  it("finding #4: a retarget does not leave the document refcounted for a tab that no longer exists", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();
    ipc.fsReadText.mockResolvedValue({
      text: "x",
      encoding: "utf8",
      eol: "lf",
      mixedEol: false,
      hash: "h",
      mtimeMs: 1,
      size: 1,
      readOnly: false,
      readOnlyReason: null,
    });

    // Mirrors what the (fixed) ViewerPanel lifecycle hook does: one `load()` when the tab
    // opens, tracked by the tab's stable id — a retarget changes only `rel`, and (per the
    // pure `diffLoadedTabs` helper) must trigger neither an extra `load()` nor a `release()`,
    // since `rekeyDocsForRetarget` already moves the existing refcount to the new key.
    store.useViewerStore.getState().openFile("ws1", "old.txt", { pinned: true });
    await store.useDocumentStore.getState().load("ws1", "old.txt");

    store.useViewerStore.getState().retarget("ws1", "old.txt", "new.txt");

    // Closing the (single) tab now releases exactly once — if the retarget had leaked an
    // extra refcount, the document would still be present after this single release.
    store.useDocumentStore.getState().release("ws1", "new.txt");

    expect(store.useDocumentStore.getState().docs[store.docKey("ws1", "new.txt")]).toBeUndefined();
  });
});

describe("persistence", () => {
  it("serializes tabs (rel, pinned, mode) and activeRel per workspace, debounced", async () => {
    const store = await freshStore();
    vi.useFakeTimers();
    try {
      await store.useViewerStore.getState().init();
      store.useViewerStore.getState().openFile("ws1", "a.txt", { pinned: true });
      store.useViewerStore.getState().openFile("ws1", "b.txt", { pinned: false });

      await vi.advanceTimersByTimeAsync(600);

      expect(ipc.saveStateSlice).toHaveBeenCalledWith(
        "viewer",
        expect.objectContaining({
          ws1: {
            tabs: [
              { rel: "a.txt", pinned: true, mode: undefined },
              { rel: "b.txt", pinned: false, mode: undefined },
            ],
            activeRel: "b.txt",
          },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores persisted tabs on init(), dropping ones whose file no longer exists", async () => {
    const store = await freshStore();
    ipc.loadState.mockResolvedValue({
      viewer: {
        ws1: {
          tabs: [
            { rel: "kept.txt", pinned: true },
            { rel: "gone.txt", pinned: false },
          ],
          activeRel: "gone.txt",
        },
      },
    });
    ipc.fsExists.mockImplementation(async (_ws: string, rel: string) => rel !== "gone.txt");

    await store.useViewerStore.getState().init();

    const tabs = tabsOf(store, "ws1");
    expect(tabs.map((t) => t.rel)).toEqual(["kept.txt"]);
    // activeRel pointed at the dropped tab — falls back to the last remaining tab.
    expect(activeRelOf(store, "ws1")).toBe("kept.txt");
  });

  it("drops persisted entries for workspaces that no longer exist", async () => {
    const store = await freshStore();
    ipc.loadState.mockResolvedValue({
      viewer: {
        "gone-ws": { tabs: [{ rel: "a.txt", pinned: true }], activeRel: "a.txt" },
      },
    });
    ipc.workspaceList.mockResolvedValue({ workspaces: [{ id: "ws1", name: "ws1", path: "C:\\ws1", expandedDirs: [] }], activeId: "ws1" });

    await store.useViewerStore.getState().init();

    expect(store.useViewerStore.getState().byWorkspace["gone-ws"]).toBeUndefined();
  });
});

describe("workspaces:changed pruning", () => {
  it("removes tab state for workspaces no longer in the list", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();
    store.useViewerStore.getState().openFile("ws1", "a.txt", { pinned: true });

    workspacesChangedHandler!({ workspaces: [], activeId: null });

    expect(store.useViewerStore.getState().byWorkspace["ws1"]).toBeUndefined();
  });
});

describe("fs:changed / fs:rescan: deleted-file tabs", () => {
  it("a clean tab whose file is gone is closed silently", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();
    store.useViewerStore.getState().openFile("ws1", "dir/a.txt", { pinned: true });
    ipc.fsExists.mockResolvedValue(false);

    fsChangedHandler!({ workspaceId: "ws1", dirs: ["dir"] });
    await vi.waitFor(() => expect(tabsOf(store, "ws1")).toHaveLength(0));
  });

  it("a dirty tab whose file is gone stays open and is flagged missing", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();
    store.useViewerStore.getState().openFile("ws1", "dir/a.txt", { pinned: true });
    store.useDocumentStore.setState({
      docs: {
        [store.docKey("ws1", "dir/a.txt")]: {
          status: "ready",
          text: "changed",
          savedText: "orig",
          encoding: "utf8",
          eol: "lf",
          mixedEol: false,
          hash: "h",
          readOnly: false,
          readOnlyReason: null,
          dirty: true,
          external: null,
        },
      },
    });
    ipc.fsExists.mockResolvedValue(false);

    fsChangedHandler!({ workspaceId: "ws1", dirs: ["dir"] });
    await vi.waitFor(() => {
      const tabs = tabsOf(store, "ws1");
      expect(tabs).toHaveLength(1);
      expect(tabs[0]?.missing).toBe(true);
    });
  });

  it("fs:rescan checks every tab of the workspace regardless of dirs", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();
    store.useViewerStore.getState().openFile("ws1", "a.txt", { pinned: true });
    store.useViewerStore.getState().openFile("ws1", "deep/b.txt", { pinned: true });
    ipc.fsExists.mockResolvedValue(true);

    fsRescanHandler!({ workspaceId: "ws1" });

    await vi.waitFor(() => expect(ipc.fsExists).toHaveBeenCalledWith("ws1", "a.txt"));
    expect(ipc.fsExists).toHaveBeenCalledWith("ws1", "deep/b.txt");
  });

  it("finding #11: a directory rename reported only at the parent still checks tabs nested deeper inside it", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();
    store.useViewerStore.getState().openFile("ws1", "old/deep/nested/a.txt", { pinned: true });
    ipc.fsExists.mockResolvedValue(false);

    // Backend only reports the renamed dir's *parent* ("") — not "old/deep/nested" itself.
    fsChangedHandler!({ workspaceId: "ws1", dirs: [""] });

    await vi.waitFor(() => expect(tabsOf(store, "ws1")).toHaveLength(0));
  });
});

describe("openFile with line/column (faz4-spec §2.6, terminal file links)", () => {
  it("sets a transient revealTarget on a newly opened tab and pins it", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();

    store.useViewerStore.getState().openFile("ws1", "src/a.ts", { pinned: true, line: 42, column: 7 });

    const tab = tabsOf(store, "ws1")[0]!;
    expect(tab.revealTarget).toEqual({ line: 42, column: 7 });
  });

  it("sets revealTarget on an already-open tab too (single click doesn't unpin it)", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();
    store.useViewerStore.getState().openFile("ws1", "src/a.ts", { pinned: true });

    store.useViewerStore.getState().openFile("ws1", "src/a.ts", { pinned: true, line: 10 });

    const tab = tabsOf(store, "ws1")[0]!;
    expect(tab.revealTarget).toEqual({ line: 10, column: null });
  });

  it("switches a markdown tab to 'edit' mode when a line is given (source view needed to reveal)", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();

    store.useViewerStore.getState().openFile("ws1", "readme.md", { pinned: true, line: 5 });

    expect(tabsOf(store, "ws1")[0]).toMatchObject({ mode: "edit", revealTarget: { line: 5, column: null } });
  });

  it("does not set a mode/revealTarget for a plain click with no line given", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();

    store.useViewerStore.getState().openFile("ws1", "readme.md", { pinned: true });

    expect(tabsOf(store, "ws1")[0]).toMatchObject({ mode: "preview", revealTarget: null });
  });

  it("clearReveal removes the transient target without touching anything else", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();
    store.useViewerStore.getState().openFile("ws1", "src/a.ts", { pinned: true, line: 42 });
    const tabId = tabsOf(store, "ws1")[0]!.id;

    store.useViewerStore.getState().clearReveal("ws1", tabId);

    expect(tabsOf(store, "ws1")[0]?.revealTarget).toBeNull();
  });

  it("revealTarget is not part of the persisted shape", async () => {
    const store = await freshStore();
    vi.useFakeTimers();
    try {
      await store.useViewerStore.getState().init();
      store.useViewerStore.getState().openFile("ws1", "src/a.ts", { pinned: true, line: 42 });
      await vi.advanceTimersByTimeAsync(600);
      // "Son çağrı"ya bakılmaz: önceki bir testin (gerçek zamanlayıcılı, eski modül örneği)
      // debounce'u bu testin sırasında düşüp araya çağrı ekleyebiliyordu (aralıklı kırılma).
      const payloads = ipc.saveStateSlice.mock.calls.map((c) => c[1]);
      expect(payloads).toContainEqual({
        ws1: { tabs: [{ rel: "src/a.ts", pinned: true, mode: undefined }], activeRel: "src/a.ts" },
      });
      expect(JSON.stringify(payloads)).not.toContain("revealTarget");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("init() re-entrancy (finding #16)", () => {
  it("two concurrent init() calls only fetch the persisted state once", async () => {
    const store = await freshStore();
    const p1 = store.useViewerStore.getState().init();
    const p2 = store.useViewerStore.getState().init();

    await Promise.all([p1, p2]);

    expect(ipc.loadState).toHaveBeenCalledTimes(1);
    expect(ipc.workspaceList).toHaveBeenCalledTimes(1);
    expect(store.useViewerStore.getState().ready).toBe(true);
  });

  it("a call after init() has already settled is a cheap no-op", async () => {
    const store = await freshStore();
    await store.useViewerStore.getState().init();
    await store.useViewerStore.getState().init();

    expect(ipc.loadState).toHaveBeenCalledTimes(1);
  });
});

describe("diff tabs (M4 timeline)", () => {
  it("live next to the file's own tab, are reused, never persisted and survive a deleted file", async () => {
    const store = await freshStore();
    vi.useFakeTimers();
    try {
      await store.useViewerStore.getState().init();
      store.useViewerStore.getState().openFile("ws1", "a.txt", { pinned: true });
      store.useViewerStore.getState().openDiff("ws1", "a.txt");
      store.useViewerStore.getState().openDiff("ws1", "a.txt");
      expect(tabsOf(store, "ws1").map((t) => [t.rel, t.diff ?? false])).toEqual([
        ["a.txt", false],
        ["a.txt", true],
      ]);
      // A single click on the file activates its own tab, not the diff; a preview never replaces a diff.
      store.useViewerStore.getState().openFile("ws1", "a.txt", { pinned: false });
      expect(store.useViewerStore.getState().byWorkspace.ws1?.activeTabId).toBe(tabsOf(store, "ws1")[0]!.id);
      store.useViewerStore.getState().openFile("ws1", "b.txt", { pinned: false });
      expect(tabsOf(store, "ws1").filter((t) => t.diff)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(600);
      const calls = ipc.saveStateSlice.mock.calls;
      const saved = calls[calls.length - 1]?.[1] as Record<string, { tabs: { rel: string }[] }>;
      expect(saved.ws1!.tabs.map((t) => t.rel)).toEqual(["a.txt", "b.txt"]);

      ipc.fsExists.mockResolvedValue(false);
      fsChangedHandler?.({ workspaceId: "ws1", dirs: [""] });
      await vi.advanceTimersByTimeAsync(10);
      expect(tabsOf(store, "ws1").map((t) => [t.rel, t.diff ?? false])).toEqual([["a.txt", true]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
