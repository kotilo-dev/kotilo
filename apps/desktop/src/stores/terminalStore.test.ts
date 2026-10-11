import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspacesState } from "../lib/ipc";

const ipc = vi.hoisted(() => ({
  loadState: vi.fn(),
  saveStateSlice: vi.fn(),
  workspaceList: vi.fn(),
  ptyProfiles: vi.fn(),
  ptySpawn: vi.fn(),
  ptyKill: vi.fn(),
  ptyBusy: vi.fn(),
  appInfo: vi.fn(),
  onPtyExit: vi.fn(),
  onWorkspacesChanged: vi.fn(),
  isAppError: (e: unknown, code?: string): e is { code: string; message: string } =>
    typeof e === "object" && e !== null && "code" in e && (code === undefined || (e as { code: string }).code === code),
  toAppError: (e: unknown) => {
    if (typeof e === "object" && e !== null && "code" in e && "message" in e) return e;
    return { code: "io", message: String(e) };
  },
  Channel: class FakeChannel<T> {
    onmessage: ((data: T) => void) | undefined;
  },
}));

vi.mock("../lib/ipc", () => ipc);

interface FakeTerm {
  cols: number;
  rows: number;
  write: (data: string | Uint8Array, callback?: () => void) => void;
  dispose: () => void;
  reset: () => void;
}

function makeFakeTerm(): FakeTerm {
  return { cols: 80, rows: 24, write: vi.fn(), dispose: vi.fn(), reset: vi.fn() };
}

let ptyExitHandler: ((p: { paneId: string; exitCode: number }) => void) | undefined;
let workspacesChangedHandler: ((p: WorkspacesState) => void) | undefined;

async function freshStore() {
  vi.resetModules();
  ptyExitHandler = undefined;
  workspacesChangedHandler = undefined;

  ipc.onPtyExit.mockImplementation((h: typeof ptyExitHandler) => {
    ptyExitHandler = h;
    return Promise.resolve(() => {});
  });
  ipc.onWorkspacesChanged.mockImplementation((h: typeof workspacesChangedHandler) => {
    workspacesChangedHandler = h;
    return Promise.resolve(() => {});
  });

  // `vi.resetModules()` gives every test its own isolated `terminalRegistry` instance (fresh
  // `entries` Map) — the fake terminal factory must be installed on *that* instance, so the
  // registry module is imported dynamically here (never as a static top-of-file import, which
  // would keep binding to the pre-reset module).
  const registryMod = await import("../features/terminal/terminalRegistry");
  registryMod.setCreateTerminalFactory(() => makeFakeTerm());
  const storeMod = await import("./terminalStore");
  return { ...storeMod, ...registryMod };
}

function makeDeferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  Object.values(ipc).forEach((fn) => {
    if (typeof fn === "function" && "mockReset" in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  });
  ipc.loadState.mockResolvedValue({});
  ipc.saveStateSlice.mockResolvedValue(undefined);
  ipc.workspaceList.mockResolvedValue({
    workspaces: [
      { id: "ws1", name: "ws1", path: "C:\\ws1", expandedDirs: [] },
      { id: "ws2", name: "ws2", path: "C:\\ws2", expandedDirs: [] },
    ],
    activeId: "ws1",
  });
  ipc.ptyProfiles.mockResolvedValue([{ id: "pwsh", name: "PowerShell", program: "pwsh.exe", args: [] }]);
  ipc.ptyKill.mockResolvedValue(undefined);
  ipc.appInfo.mockResolvedValue({ osBuild: 22631 });
});

function tabsOf(store: Awaited<ReturnType<typeof freshStore>>, workspaceId: string) {
  return store.useTerminalStore.getState().byWorkspace[workspaceId]?.tabs ?? [];
}

describe("newTerminal / activate / closeTab — per-workspace separation", () => {
  it("keeps tabs of different workspaces independent", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    const idA = store.useTerminalStore.getState().newTerminal("ws1");
    store.useTerminalStore.getState().newTerminal("ws2");

    expect(tabsOf(store, "ws1")).toHaveLength(1);
    expect(tabsOf(store, "ws2")).toHaveLength(1);
    expect(store.useTerminalStore.getState().byWorkspace.ws1?.activeTabId).toBe(idA);
  });

  it("closing the active tab activates a neighbor", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    const a = store.useTerminalStore.getState().newTerminal("ws1");
    const b = store.useTerminalStore.getState().newTerminal("ws1");

    await store.useTerminalStore.getState().closeTab("ws1", b);

    expect(tabsOf(store, "ws1").map((t) => t.id)).toEqual([a]);
    expect(store.useTerminalStore.getState().byWorkspace.ws1?.activeTabId).toBe(a);
  });
});

describe("autoStart flag (LOW #3, D21)", () => {
  it("newTerminal sets autoStart:true on both shell and agent tabs", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    const shellId = store.useTerminalStore.getState().newTerminal("ws1");
    const agentId = store.useTerminalStore.getState().newTerminal("ws1", { agentCommand: "claude" });

    expect(tabsOf(store, "ws1").find((t) => t.id === shellId)?.autoStart).toBe(true);
    expect(tabsOf(store, "ws1").find((t) => t.id === agentId)?.autoStart).toBe(true);
  });

  it("a tab restored from persisted state never has autoStart", async () => {
    const store = await freshStore();
    ipc.loadState.mockResolvedValue({
      terminals: {
        ws1: {
          tabs: [{ title: "claude", titleEdited: false, profileId: null, cwdRel: "", agentCommand: "claude" }],
          activeIndex: 0,
        },
      },
    });

    await store.useTerminalStore.getState().init();

    expect(tabsOf(store, "ws1")[0]?.autoStart).toBeFalsy();
  });

  it("the persisted slice never contains autoStart", async () => {
    const store = await freshStore();
    vi.useFakeTimers();
    try {
      await store.useTerminalStore.getState().init();
      store.useTerminalStore.getState().newTerminal("ws1", { agentCommand: "claude" });
      await vi.advanceTimersByTimeAsync(600);

      const calls = ipc.saveStateSlice.mock.calls;
      const call = calls[calls.length - 1];
      const persistedTabs = (call?.[1] as { ws1: { tabs: Array<Record<string, unknown>> } }).ws1.tabs;
      expect(persistedTabs).toHaveLength(1);
      expect(persistedTabs[0]).not.toHaveProperty("autoStart");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("start()", () => {
  it("is idempotent — a second call while starting/running does not spawn again", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    const deferred = makeDeferred<{ paneId: string; pid: number }>();
    ipc.ptySpawn.mockReturnValue(deferred.promise);

    const tabId = store.useTerminalStore.getState().newTerminal("ws1");
    const p1 = store.useTerminalStore.getState().start("ws1", tabId);
    const p2 = store.useTerminalStore.getState().start("ws1", tabId); // StrictMode double-call

    deferred.resolve({ paneId: "pane-1", pid: 123 });
    await Promise.all([p1, p2]);

    expect(ipc.ptySpawn).toHaveBeenCalledTimes(1);
    expect(tabsOf(store, "ws1")[0]).toMatchObject({ status: "running", paneId: "pane-1", pid: 123 });
  });

  it("retries with cwdRel '' when the backend reports not_found/not_a_directory (§4.10)", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    ipc.ptySpawn
      .mockRejectedValueOnce({ code: "not_found", message: "x" })
      .mockResolvedValueOnce({ paneId: "pane-2", pid: 55 });

    const tabId = store.useTerminalStore.getState().newTerminal("ws1", { cwdRel: "missing" });
    await store.useTerminalStore.getState().start("ws1", tabId);

    expect(ipc.ptySpawn).toHaveBeenCalledTimes(2);
    expect(ipc.ptySpawn.mock.calls[1]![0]).toMatchObject({ cwdRel: "" });
    const tab = tabsOf(store, "ws1")[0]!;
    expect(tab.status).toBe("running");
    expect(tab.cwdRel).toBe("");
  });
});

describe("closing while starting — spawn failure path (MEDIUM #5)", () => {
  it("does not retry the cwd-fallback and instead removes the tab if the user closed it before a not_found rejection", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    const deferred = makeDeferred<{ paneId: string; pid: number }>();
    ipc.ptySpawn.mockReturnValue(deferred.promise);

    const tabId = store.useTerminalStore.getState().newTerminal("ws1", { cwdRel: "missing" });
    const startPromise = store.useTerminalStore.getState().start("ws1", tabId);
    await store.useTerminalStore.getState().closeTab("ws1", tabId); // still "starting" → closing:true

    deferred.reject({ code: "not_found", message: "x" });
    await startPromise;

    // Must NOT retry with cwdRel "" (that would resurrect a tab the user asked to close).
    expect(ipc.ptySpawn).toHaveBeenCalledTimes(1);
    expect(tabsOf(store, "ws1")).toHaveLength(0);
  });

  it("does not leave the tab 'exited' and does not retry a generic spawn failure once closing", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    const deferred = makeDeferred<{ paneId: string; pid: number }>();
    ipc.ptySpawn.mockReturnValue(deferred.promise);

    const tabId = store.useTerminalStore.getState().newTerminal("ws1");
    const startPromise = store.useTerminalStore.getState().start("ws1", tabId);
    await store.useTerminalStore.getState().closeTab("ws1", tabId);

    deferred.reject({ code: "spawn_failed", message: "boom" });
    await startPromise;

    expect(tabsOf(store, "ws1")).toHaveLength(0);
  });

  it("a normal (non-closing) not_found failure still retries with cwdRel '' as before", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    ipc.ptySpawn
      .mockRejectedValueOnce({ code: "not_found", message: "x" })
      .mockResolvedValueOnce({ paneId: "pane-retry", pid: 9 });

    const tabId = store.useTerminalStore.getState().newTerminal("ws1", { cwdRel: "missing" });
    await store.useTerminalStore.getState().start("ws1", tabId);

    expect(ipc.ptySpawn).toHaveBeenCalledTimes(2);
    expect(tabsOf(store, "ws1")[0]).toMatchObject({ status: "running", cwdRel: "" });
  });
});

describe("earlyExits (§4.7)", () => {
  it("a pty:exit that arrives before pty_spawn resolves is applied once start() settles", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    const deferred = makeDeferred<{ paneId: string; pid: number }>();
    ipc.ptySpawn.mockReturnValue(deferred.promise);

    const tabId = store.useTerminalStore.getState().newTerminal("ws1"); // plain shell
    const startPromise = store.useTerminalStore.getState().start("ws1", tabId);

    // The exit event names a paneId the store doesn't know about yet.
    ptyExitHandler!({ paneId: "pane-3", exitCode: 0 });
    deferred.resolve({ paneId: "pane-3", pid: 9 });
    await startPromise;

    // Plain shell + exit 0 → auto-closed.
    expect(tabsOf(store, "ws1")).toHaveLength(0);
  });
});

describe("closing while starting (§4.7)", () => {
  it("kills the pane and removes the tab once spawn resolves, instead of adopting it", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    const deferred = makeDeferred<{ paneId: string; pid: number }>();
    ipc.ptySpawn.mockReturnValue(deferred.promise);

    const tabId = store.useTerminalStore.getState().newTerminal("ws1");
    const startPromise = store.useTerminalStore.getState().start("ws1", tabId);
    await store.useTerminalStore.getState().closeTab("ws1", tabId); // still "starting"

    deferred.resolve({ paneId: "pane-4", pid: 1 });
    await startPromise;

    expect(ipc.ptyKill).toHaveBeenCalledWith("pane-4");
    expect(tabsOf(store, "ws1")).toHaveLength(0);
  });
});

describe("pty:exit after a user-initiated kill is a no-op (§4.7)", () => {
  it("does not throw and leaves no trace once the tab is already gone", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    ipc.ptySpawn.mockResolvedValue({ paneId: "pane-5", pid: 7 });

    const tabId = store.useTerminalStore.getState().newTerminal("ws1", { agentCommand: "claude" });
    await store.useTerminalStore.getState().start("ws1", tabId);
    await store.useTerminalStore.getState().closeTab("ws1", tabId);

    expect(() => ptyExitHandler!({ paneId: "pane-5", exitCode: 130 })).not.toThrow();
    expect(tabsOf(store, "ws1")).toHaveLength(0);
  });

  it("a deliberately-killed pane's exit does not leak into earlyExits (LOW #6)", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    ipc.ptySpawn.mockResolvedValue({ paneId: "pane-leak", pid: 7 });

    const tabId = store.useTerminalStore.getState().newTerminal("ws1");
    await store.useTerminalStore.getState().start("ws1", tabId);
    await store.useTerminalStore.getState().closeTab("ws1", tabId);

    ptyExitHandler!({ paneId: "pane-leak", exitCode: 0 });

    expect(store.earlyExitsSizeForTest()).toBe(0);
  });
});

describe("exit 0 auto-close rule (§2.2)", () => {
  it("closes a plain shell tab automatically on exit code 0", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    ipc.ptySpawn.mockResolvedValue({ paneId: "pane-6", pid: 1 });

    const tabId = store.useTerminalStore.getState().newTerminal("ws1");
    await store.useTerminalStore.getState().start("ws1", tabId);
    ptyExitHandler!({ paneId: "pane-6", exitCode: 0 });

    expect(tabsOf(store, "ws1")).toHaveLength(0);
  });

  it("keeps an agent tab open on exit code 0 (shows Restart/Close instead)", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    ipc.ptySpawn.mockResolvedValue({ paneId: "pane-7", pid: 1 });

    const tabId = store.useTerminalStore.getState().newTerminal("ws1", { agentCommand: "claude" });
    await store.useTerminalStore.getState().start("ws1", tabId);
    ptyExitHandler!({ paneId: "pane-7", exitCode: 0 });

    const tabs = tabsOf(store, "ws1");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ status: "exited", exitCode: 0 });
  });

  it("keeps a plain shell tab open (Restart/Close) on a non-zero exit code", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    ipc.ptySpawn.mockResolvedValue({ paneId: "pane-8", pid: 1 });

    const tabId = store.useTerminalStore.getState().newTerminal("ws1");
    await store.useTerminalStore.getState().start("ws1", tabId);
    ptyExitHandler!({ paneId: "pane-8", exitCode: 3 });

    const tabs = tabsOf(store, "ws1");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ status: "exited", exitCode: 3 });
  });
});

describe("restart() (§2.2, §4.7)", () => {
  it("kills the old pane, resets the terminal and spawns a fresh pane with a new channel", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    ipc.ptySpawn.mockResolvedValueOnce({ paneId: "pane-9", pid: 1 }).mockResolvedValueOnce({ paneId: "pane-10", pid: 2 });

    const tabId = store.useTerminalStore.getState().newTerminal("ws1");
    await store.useTerminalStore.getState().start("ws1", tabId); // still "running" — pane-9 is live

    const entry = store.getEntry(tabId)!;
    await store.useTerminalStore.getState().restart("ws1", tabId);

    expect(ipc.ptyKill).toHaveBeenCalledWith("pane-9");
    expect(entry.term.reset as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(tabsOf(store, "ws1")[0]).toMatchObject({ status: "running", paneId: "pane-10" });
  });
});

describe("titleEdited rule (§2.2)", () => {
  it("setAutoTitle updates the title only when the user hasn't renamed the tab", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    const tabId = store.useTerminalStore.getState().newTerminal("ws1");

    store.useTerminalStore.getState().setAutoTitle("ws1", tabId, "claude — working");
    expect(tabsOf(store, "ws1")[0]?.title).toBe("claude — working");

    store.useTerminalStore.getState().rename("ws1", tabId, "My shell");
    store.useTerminalStore.getState().setAutoTitle("ws1", tabId, "should not apply");
    expect(tabsOf(store, "ws1")[0]?.title).toBe("My shell");
  });

  it("rename() ignores an empty name", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    const tabId = store.useTerminalStore.getState().newTerminal("ws1");
    const before = tabsOf(store, "ws1")[0]!.title;

    store.useTerminalStore.getState().rename("ws1", tabId, "");

    expect(tabsOf(store, "ws1")[0]?.title).toBe(before);
    expect(tabsOf(store, "ws1")[0]?.titleEdited).toBe(false);
  });
});

describe("init() — windowsPty build number (LOW #8c)", () => {
  it("awaits app_info() before ready flips (so restored terminals can carry the build number)", async () => {
    const store = await freshStore();
    ipc.appInfo.mockResolvedValue({ osBuild: 26100 });

    await store.useTerminalStore.getState().init();

    expect(ipc.appInfo).toHaveBeenCalledTimes(1);
    expect(store.useTerminalStore.getState().ready).toBe(true);
  });

  it("a failed app_info() is skipped — init() still completes", async () => {
    const store = await freshStore();
    ipc.appInfo.mockRejectedValue(new Error("no app_info"));

    await expect(store.useTerminalStore.getState().init()).resolves.toBeUndefined();
    expect(store.useTerminalStore.getState().ready).toBe(true);
  });
});

describe("persistence", () => {
  it("serializes tabs (incl. titleEdited/profileId/cwdRel/agentCommand) and activeIndex, debounced", async () => {
    const store = await freshStore();
    vi.useFakeTimers();
    try {
      await store.useTerminalStore.getState().init();
      store.useTerminalStore.getState().newTerminal("ws1", { profileId: "pwsh", cwdRel: "src" });
      const b = store.useTerminalStore.getState().newTerminal("ws1", { agentCommand: "claude" });
      store.useTerminalStore.getState().activate("ws1", b);

      await vi.advanceTimersByTimeAsync(600);

      expect(ipc.saveStateSlice).toHaveBeenCalledWith(
        "terminals",
        expect.objectContaining({
          ws1: expect.objectContaining({
            tabs: [
              expect.objectContaining({ profileId: "pwsh", cwdRel: "src", agentCommand: null }),
              expect.objectContaining({ agentCommand: "claude" }),
            ],
            activeIndex: 1,
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores persisted tabs on init() without auto-starting an agent tab (D21)", async () => {
    const store = await freshStore();
    ipc.loadState.mockResolvedValue({
      terminals: {
        ws1: {
          tabs: [
            { title: "PowerShell", titleEdited: false, profileId: "pwsh", cwdRel: "", agentCommand: null },
            { title: "claude", titleEdited: false, profileId: null, cwdRel: "", agentCommand: "claude" },
          ],
          activeIndex: 0,
        },
      },
    });

    await store.useTerminalStore.getState().init();

    const tabs = tabsOf(store, "ws1");
    expect(tabs).toHaveLength(2);
    expect(tabs.every((t) => t.status === "idle")).toBe(true);
    expect(ipc.ptySpawn).not.toHaveBeenCalled();
    const agentTab = tabs.find((t) => t.agentCommand === "claude");
    expect(agentTab?.title).toBe("claude");
  });

  it("keeps a saved custom title only when titleEdited was true (§4.12)", async () => {
    const store = await freshStore();
    ipc.loadState.mockResolvedValue({
      terminals: {
        ws1: {
          tabs: [{ title: "My renamed tab", titleEdited: true, profileId: "pwsh", cwdRel: "", agentCommand: null }],
          activeIndex: 0,
        },
      },
    });

    await store.useTerminalStore.getState().init();

    expect(tabsOf(store, "ws1")[0]?.title).toBe("My renamed tab");
  });

  it("drops persisted entries for workspaces that no longer exist", async () => {
    const store = await freshStore();
    ipc.loadState.mockResolvedValue({
      terminals: { "gone-ws": { tabs: [{ title: "x", titleEdited: false, profileId: null, cwdRel: "", agentCommand: null }], activeIndex: 0 } },
    });

    await store.useTerminalStore.getState().init();

    expect(store.useTerminalStore.getState().byWorkspace["gone-ws"]).toBeUndefined();
  });
});

describe("workspaces:changed pruning (§2.2)", () => {
  it("kills panes and removes tab state for workspaces no longer in the list", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    ipc.ptySpawn.mockResolvedValue({ paneId: "pane-11", pid: 1 });
    const tabId = store.useTerminalStore.getState().newTerminal("ws1");
    await store.useTerminalStore.getState().start("ws1", tabId);

    workspacesChangedHandler!({ workspaces: [{ id: "ws2", name: "ws2", path: "C:\\ws2", expandedDirs: [] }], activeId: "ws2" });

    expect(ipc.ptyKill).toHaveBeenCalledWith("pane-11");
    expect(store.useTerminalStore.getState().byWorkspace["ws1"]).toBeUndefined();
  });
});

describe("runningCount (§4.11)", () => {
  it("counts running and starting tabs, not idle/exited ones", async () => {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    const deferred = makeDeferred<{ paneId: string; pid: number }>();
    ipc.ptySpawn.mockReturnValueOnce(deferred.promise).mockResolvedValue({ paneId: "pane-13", pid: 2 });

    store.useTerminalStore.getState().newTerminal("ws1"); // idle
    const starting = store.useTerminalStore.getState().newTerminal("ws1");
    const running = store.useTerminalStore.getState().newTerminal("ws1");

    const p = store.useTerminalStore.getState().start("ws1", starting);
    await store.useTerminalStore.getState().start("ws1", running);

    expect(store.useTerminalStore.getState().runningCount("ws1")).toBe(2);

    deferred.resolve({ paneId: "pane-12", pid: 1 });
    await p;
  });
});

describe("split pane (M4)", () => {
  // Persist debounces from earlier tests run on real timers in their own module instances and
  // would land in the save assertions below on a busy machine: let them fire first, then keep
  // this block on fake timers so it leaks none itself.
  beforeAll(() => new Promise((resolve) => setTimeout(resolve, 600)));
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function threeTabs() {
    const store = await freshStore();
    await store.useTerminalStore.getState().init();
    const a = store.useTerminalStore.getState().newTerminal("ws1");
    const b = store.useTerminalStore.getState().newTerminal("ws1");
    const c = store.useTerminalStore.getState().newTerminal("ws1");
    return { store, a, b, c, ws: () => store.useTerminalStore.getState().byWorkspace.ws1! };
  }

  it("setSplit shows two distinct tabs; activating the right one keeps the split", async () => {
    const { store, a, b, ws } = await threeTabs();
    store.useTerminalStore.getState().setSplit("ws1", a, b);
    expect(ws()).toMatchObject({ activeTabId: a, splitTabId: b });
    store.useTerminalStore.getState().activate("ws1", b);
    expect(ws()).toMatchObject({ activeTabId: a, splitTabId: b });
    store.useTerminalStore.getState().setSplit("ws1", a, a);
    store.useTerminalStore.getState().setSplit("ws1", a, "nope");
    expect(ws()).toMatchObject({ activeTabId: a, splitTabId: b });
  });

  it("activating another tab replaces the left half; a new terminal also opens on the left", async () => {
    const { store, a, b, c, ws } = await threeTabs();
    store.useTerminalStore.getState().setSplit("ws1", a, b);
    store.useTerminalStore.getState().activate("ws1", c);
    expect(ws()).toMatchObject({ activeTabId: c, splitTabId: b });
    const d = store.useTerminalStore.getState().newTerminal("ws1");
    expect(ws()).toMatchObject({ activeTabId: d, splitTabId: b });
  });

  it("closeSplit keeps the chosen half and both tabs", async () => {
    const { store, a, b, ws } = await threeTabs();
    store.useTerminalStore.getState().setSplit("ws1", a, b);
    store.useTerminalStore.getState().closeSplit("ws1", "right");
    expect(ws()).toMatchObject({ activeTabId: b, splitTabId: null });
    expect(ws().tabs).toHaveLength(3);
  });

  it("setFocusedTab records the focused half without persisting it", async () => {
    const { store, a, b, ws } = await threeTabs();
    store.useTerminalStore.getState().setSplit("ws1", a, b);
    await vi.advanceTimersByTimeAsync(600);
    ipc.saveStateSlice.mockClear();
    store.useTerminalStore.getState().setFocusedTab("ws1", b);
    expect(ws().focusedTabId).toBe(b);
    await vi.advanceTimersByTimeAsync(600);
    expect(ipc.saveStateSlice).not.toHaveBeenCalled();
  });

  it("closing either half's tab returns to a single pane", async () => {
    const { store, a, b, c, ws } = await threeTabs();
    store.useTerminalStore.getState().setSplit("ws1", a, b);
    await store.useTerminalStore.getState().closeTab("ws1", a);
    expect(ws()).toMatchObject({ activeTabId: b, splitTabId: null });
    store.useTerminalStore.getState().setSplit("ws1", b, c);
    await store.useTerminalStore.getState().closeTab("ws1", c);
    expect(ws()).toMatchObject({ activeTabId: b, splitTabId: null });
  });

  it("persists splitIndex and restores it on init", async () => {
    const { store, a, c } = await threeTabs();
    store.useTerminalStore.getState().setSplit("ws1", a, c);
    await vi.advanceTimersByTimeAsync(600);
    const last = ipc.saveStateSlice.mock.lastCall!;
    expect(last[1].ws1).toMatchObject({ activeIndex: 0, splitIndex: 2 });
    store.useTerminalStore.getState().closeSplit("ws1", "left");
    await vi.advanceTimersByTimeAsync(600);
    expect("splitIndex" in ipc.saveStateSlice.mock.lastCall![1].ws1).toBe(false);

    const restored = await freshStore();
    const tab = { title: "PowerShell", titleEdited: false, profileId: "pwsh", cwdRel: "", agentCommand: null };
    ipc.loadState.mockResolvedValue({ terminals: { ws1: { tabs: [tab, tab, tab], activeIndex: 1, splitIndex: 0 } } });
    await restored.useTerminalStore.getState().init();
    const ws = restored.useTerminalStore.getState().byWorkspace.ws1!;
    expect(ws.activeTabId).toBe(ws.tabs[1]!.id);
    expect(ws.splitTabId).toBe(ws.tabs[0]!.id);
  });
});
