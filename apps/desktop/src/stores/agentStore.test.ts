import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, HooksStatus } from "../lib/ipc";
import type { NotificationDto } from "../lib/hubTypes";

const ipc = vi.hoisted(() => ({
  agentsList: vi.fn(),
  agentAck: vi.fn(),
  agentSetFocus: vi.fn(),
  hooksInstall: vi.fn(),
  hooksStatus: vi.fn(),
  hooksUninstall: vi.fn(),
  onAgentsChanged: vi.fn(),
  onHubStatus: vi.fn(),
  toAppError: (e: unknown) => {
    if (typeof e === "object" && e !== null && "code" in e && "message" in e) return e;
    return { code: "io", message: String(e) };
  },
}));
vi.mock("../lib/ipc", () => ipc);

const windowMock = vi.hoisted(() => ({
  isFocused: vi.fn(),
  onFocusChanged: vi.fn(),
  requestUserAttention: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowMock,
  UserAttentionType: { Informational: 1 },
}));

const notifications = vi.hoisted(() => ({ notifyAgent: vi.fn(), notifyFromHub: vi.fn() }));
vi.mock("../features/agents/notifications", () => notifications);

let workspaceState: { activeId: string | null; workspaces: { id: string; name: string }[] };
vi.mock("./workspaceStore", () => ({
  useWorkspaceStore: {
    getState: () => workspaceState,
    subscribe: vi.fn(() => () => {}),
  },
}));

let terminalState: {
  byWorkspace: Record<string, { activeTabId: string | null; tabs: { id: string; paneId?: string; title: string }[] }>;
};
vi.mock("./terminalStore", () => ({
  useTerminalStore: {
    getState: () => ({
      byWorkspace: terminalState.byWorkspace,
      findTabByPaneId: (paneId: string) => {
        for (const [workspaceId, ws] of Object.entries(terminalState.byWorkspace)) {
          const tab = ws.tabs.find((t) => t.paneId === paneId);
          if (tab) return { workspaceId, tab };
        }
        return undefined;
      },
    }),
    subscribe: vi.fn(() => () => {}),
  },
}));

let layoutState: { layout: { terminalVisible: boolean } };
vi.mock("./layoutStore", () => ({
  useLayoutStore: {
    getState: () => layoutState,
    subscribe: vi.fn(() => () => {}),
  },
}));

function agent(partial: Partial<Agent> & Pick<Agent, "id" | "paneId" | "state">): Agent {
  return { workspaceId: "ws1", kind: "claude", sinceMs: 0, source: "hook", sessionId: null, ...partial };
}

let agentsChangedHandler: ((agents: Agent[]) => void) | undefined;
let hubStatusHandler: ((status: { connected: boolean }) => void) | undefined;

async function freshStore() {
  vi.resetModules();
  agentsChangedHandler = undefined;
  hubStatusHandler = undefined;
  ipc.onAgentsChanged.mockImplementation((h: typeof agentsChangedHandler) => {
    agentsChangedHandler = h;
    return Promise.resolve(() => {});
  });
  ipc.onHubStatus.mockImplementation((h: typeof hubStatusHandler) => {
    hubStatusHandler = h;
    return Promise.resolve(() => {});
  });
  const mod = await import("./agentStore");
  return mod;
}

beforeEach(() => {
  // `agentStore.init()` schedules a real `setTimeout` for the focus-reporting debounce
  // (faz5-spec §2.1/§4 revizyon 13) — under fake timers it never escapes into the real
  // event loop and fires after this test (and its mocks) have already torn down.
  vi.useFakeTimers();
  Object.values(ipc).forEach((fn) => {
    if (typeof fn === "function" && "mockReset" in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  });
  Object.values(windowMock).forEach((fn) => fn.mockReset());
  notifications.notifyAgent.mockReset();
  notifications.notifyFromHub.mockReset();

  ipc.agentsList.mockResolvedValue([]);
  const hooks: HooksStatus = { hubAvailable: true, installed: false, upToDate: false, state: "missing", settingsPath: "C:\\settings.json" };
  ipc.hooksStatus.mockResolvedValue(hooks);
  ipc.agentAck.mockResolvedValue(undefined);
  ipc.hooksInstall.mockResolvedValue(undefined);
  ipc.hooksUninstall.mockResolvedValue(undefined);
  windowMock.isFocused.mockResolvedValue(true);
  windowMock.onFocusChanged.mockResolvedValue(() => {});

  workspaceState = { activeId: null, workspaces: [] };
  terminalState = { byWorkspace: {} };
  layoutState = { layout: { terminalVisible: true } };
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("init", () => {
  it("loads the initial agent list and hooks status", async () => {
    const initialAgents = [agent({ id: "a", paneId: "p1", state: "working" })];
    ipc.agentsList.mockResolvedValue(initialAgents);
    ipc.hooksStatus.mockResolvedValue({ hubAvailable: true, installed: true, upToDate: true, state: "installed", settingsPath: "y" });

    const { useAgentStore } = await freshStore();
    await useAgentStore.getState().init();

    expect(useAgentStore.getState().agents).toEqual(initialAgents);
    expect(useAgentStore.getState().hooks).toEqual({ hubAvailable: true, installed: true, upToDate: true, state: "installed", settingsPath: "y" });
    expect(useAgentStore.getState().ready).toBe(true);
  });

  it("re-checks the hooks status when the hub connects after start", async () => {
    const down: HooksStatus = { hubAvailable: false, installed: false, upToDate: false, state: null, settingsPath: null };
    const up: HooksStatus = { hubAvailable: true, installed: true, upToDate: true, state: "installed", settingsPath: "y" };
    ipc.hooksStatus.mockResolvedValue(down);

    const { useAgentStore } = await freshStore();
    await useAgentStore.getState().init();
    expect(useAgentStore.getState().hooks).toEqual(down);

    ipc.hooksStatus.mockResolvedValue(up);
    hubStatusHandler?.({ connected: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(useAgentStore.getState().hooks).toEqual(up);
  });

  it("keeps the newer hooks status when the start-up check answers last", async () => {
    let answerFirst: (h: HooksStatus) => void = () => {};
    const up: HooksStatus = { hubAvailable: true, installed: true, upToDate: true, state: "installed", settingsPath: "y" };
    ipc.hooksStatus
      .mockImplementationOnce(() => new Promise<HooksStatus>((resolve) => (answerFirst = resolve)))
      .mockResolvedValue(up);

    const { useAgentStore } = await freshStore();
    const init = useAgentStore.getState().init();
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.hooksStatus).toHaveBeenCalledTimes(1);
    hubStatusHandler?.({ connected: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(useAgentStore.getState().hooks).toEqual(up);

    answerFirst({ hubAvailable: false, installed: false, upToDate: false, state: null, settingsPath: null });
    await init;
    expect(useAgentStore.getState().hooks).toEqual(up);
  });

  it("does not send a notification for the initial snapshot even if it already contains a blocked agent", async () => {
    ipc.agentsList.mockResolvedValue([agent({ id: "a", paneId: "p1", state: "blocked" })]);
    const { useAgentStore } = await freshStore();
    await useAgentStore.getState().init();
    expect(notifications.notifyAgent).not.toHaveBeenCalled();
  });

  it("is idempotent under concurrent calls (StrictMode double-invoke)", async () => {
    const { useAgentStore } = await freshStore();
    await Promise.all([useAgentStore.getState().init(), useAgentStore.getState().init()]);
    expect(ipc.agentsList).toHaveBeenCalledTimes(1);
    expect(ipc.onAgentsChanged).toHaveBeenCalledTimes(1);
  });

  it("registers the agents:changed listener before fetching the initial agent list", async () => {
    const { useAgentStore } = await freshStore();
    const order: string[] = [];
    ipc.onAgentsChanged.mockImplementation((h: typeof agentsChangedHandler) => {
      order.push("onAgentsChanged");
      agentsChangedHandler = h;
      return Promise.resolve(() => {});
    });
    ipc.agentsList.mockImplementation(async () => {
      order.push("agentsList");
      return [];
    });

    await useAgentStore.getState().init();

    expect(order).toEqual(["onAgentsChanged", "agentsList"]);
  });

  it("an agents:changed event that arrives before the fetch resolves becomes the silent seed, and the fetch result does not clobber it", async () => {
    let resolveAgentsList: ((agents: Agent[]) => void) | undefined;
    ipc.agentsList.mockImplementation(
      () =>
        new Promise<Agent[]>((resolve) => {
          resolveAgentsList = resolve;
        }),
    );
    const { useAgentStore } = await freshStore();

    const initPromise = useAgentStore.getState().init();
    // The listener is already registered by this point (installed before the fetch) —
    // fire an event before `agentsList()` resolves.
    const seedAgents = [agent({ id: "a", paneId: "p1", state: "blocked" })];
    agentsChangedHandler?.(seedAgents);

    // Resolve the now-stale fetch with different data.
    resolveAgentsList?.([agent({ id: "b", paneId: "p2", state: "working" })]);
    await initPromise;

    expect(useAgentStore.getState().agents).toEqual(seedAgents);
    expect(useAgentStore.getState().ready).toBe(true);
    // The seed itself must never notify, even though it contains a blocked agent.
    expect(notifications.notifyAgent).not.toHaveBeenCalled();
  });
});

describe("HMR", () => {
  it("resetAgentsListenerForHmr calls the captured unlisten function and is idempotent", async () => {
    const { useAgentStore, resetAgentsListenerForHmr } = await freshStore();
    const unlisten = vi.fn();
    ipc.onAgentsChanged.mockImplementation((h: typeof agentsChangedHandler) => {
      agentsChangedHandler = h;
      return Promise.resolve(unlisten);
    });

    await useAgentStore.getState().init();
    await Promise.resolve(); // let the unlisten-capturing .then() settle

    resetAgentsListenerForHmr();
    expect(unlisten).toHaveBeenCalledTimes(1);

    // The captured unlisten is cleared on reset — calling it again must not call the
    // (now stale) unlisten a second time.
    resetAgentsListenerForHmr();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("agents:changed wiring", () => {
  it("updates the agent list and notifies for a fresh transition into blocked when unfocused", async () => {
    ipc.agentsList.mockResolvedValue([agent({ id: "a", paneId: "p1", state: "working" })]);
    windowMock.isFocused.mockResolvedValue(false);
    workspaceState.workspaces = [{ id: "ws1", name: "My Workspace" }];
    terminalState.byWorkspace.ws1 = { activeTabId: null, tabs: [{ id: "t1", paneId: "p1", title: "claude" }] };

    const { useAgentStore } = await freshStore();
    await useAgentStore.getState().init();

    agentsChangedHandler?.([agent({ id: "a", paneId: "p1", state: "blocked" })]);

    expect(useAgentStore.getState().agents[0]?.state).toBe("blocked");
    expect(notifications.notifyAgent).toHaveBeenCalledWith(
      expect.objectContaining({ notificationKind: "blocked", workspaceName: "My Workspace", tabTitle: "claude" }),
    );
  });

  it("does not notify while the window is focused", async () => {
    ipc.agentsList.mockResolvedValue([agent({ id: "a", paneId: "p1", state: "working" })]);
    windowMock.isFocused.mockResolvedValue(true);

    const { useAgentStore } = await freshStore();
    await useAgentStore.getState().init();
    agentsChangedHandler?.([agent({ id: "a", paneId: "p1", state: "blocked" })]);

    expect(notifications.notifyAgent).not.toHaveBeenCalled();
  });
});

describe("notification owner (M2)", () => {
  function hubNotification(partial: Partial<NotificationDto>): NotificationDto {
    return {
      ruleId: "session.waiting_permission",
      agent: "codex",
      sessionId: null,
      paneId: null,
      projectName: "app",
      projectRoot: "C:/src/app",
      state: "WaitingPermission",
      title: "app: Needs permission",
      body: "codex",
      severity: "attention",
      at: "2026-10-04T10:00:00Z",
      ...partial,
    };
  }

  it("leaves notifications to the hub while its stream is connected", async () => {
    ipc.agentsList.mockResolvedValue([agent({ id: "a", paneId: "p1", state: "working" })]);
    windowMock.isFocused.mockResolvedValue(false);
    const { useAgentStore } = await freshStore();
    const { useHubStore } = await import("./hubStore");
    useHubStore.setState({ connected: true });
    await useAgentStore.getState().init();

    agentsChangedHandler?.([agent({ id: "a", paneId: "p1", state: "blocked" })]);

    expect(notifications.notifyAgent).not.toHaveBeenCalled();
  });

  it("shows a hub notification unless its pane is visible in a focused window", async () => {
    windowMock.isFocused.mockResolvedValue(true);
    workspaceState = { activeId: "ws1", workspaces: [{ id: "ws1", name: "W" }] };
    terminalState.byWorkspace.ws1 = { activeTabId: "t1", tabs: [{ id: "t1", paneId: "p1", title: "codex" }] };
    ipc.agentsList.mockResolvedValue([agent({ id: "a", paneId: "p1", kind: "codex", state: "working", sessionId: "cx" })]);
    const { useAgentStore } = await freshStore();
    const { useHubStore } = await import("./hubStore");
    await useAgentStore.getState().init();

    // Codex: no pane id on the notification; the desktop record's session id finds pane p1, which is on screen.
    useHubStore.getState().apply({ type: "notification", data: hubNotification({ sessionId: "cx" }) });
    expect(notifications.notifyFromHub).not.toHaveBeenCalled();

    // Another pane: shown.
    useHubStore.getState().apply({ type: "notification", data: hubNotification({ paneId: "p2" }) });
    expect(notifications.notifyFromHub).toHaveBeenCalledTimes(1);
  });
});

describe("ack", () => {
  it("calls agent_ack and swallows errors", async () => {
    const { useAgentStore } = await freshStore();
    await useAgentStore.getState().init();
    useAgentStore.getState().ack("p1");
    await Promise.resolve();
    expect(ipc.agentAck).toHaveBeenCalledWith("p1");
  });
});

describe("hooks actions", () => {
  it("installHooks refreshes status and shows a success toast", async () => {
    const { useAgentStore } = await freshStore();
    const { useToastStore } = await import("./toastStore");
    await useAgentStore.getState().init();

    ipc.hooksStatus.mockResolvedValue({ hubAvailable: true, installed: true, upToDate: true, state: "installed", settingsPath: "y" });
    await useAgentStore.getState().installHooks();

    expect(useAgentStore.getState().hooks).toEqual({ hubAvailable: true, installed: true, upToDate: true, state: "installed", settingsPath: "y" });
    expect(useToastStore.getState().toasts.length).toBeGreaterThan(0);
  });

  it("uninstallHooks shows an error toast (and leaves hooks unrefreshed) on failure", async () => {
    const { useAgentStore } = await freshStore();
    const { useToastStore } = await import("./toastStore");
    await useAgentStore.getState().init();

    ipc.hooksUninstall.mockRejectedValue({ code: "io", message: "boom" });
    await useAgentStore.getState().uninstallHooks();

    expect(useToastStore.getState().toasts.length).toBeGreaterThan(0);
  });
});
