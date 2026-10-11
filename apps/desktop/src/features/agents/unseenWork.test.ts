import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../lib/ipc";
import type { HubSettings } from "../../lib/hubTypes";
import { dictionary } from "../../app/i18n";
import { useAgentStore } from "../../stores/agentStore";
import { useHubStore } from "../../stores/hubStore";
import { DEFAULT_SETTINGS, useSettingsStore } from "../../stores/settingsStore";
import { useMascotSettingsStore } from "../settings/mascotSettings";
import { validateHubSettings } from "../settings/hubSettings";
import { makeSession } from "../workspace/sessionFixture";
import { awaySummaryText, countUnseenWork, installUnseenWork, sessionsToMarkSeen, taskbarBadge } from "./unseenWork";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
}));
const ipc = vi.hoisted(() => ({ hubRequest: vi.fn() }));
const notify = vi.hoisted(() => ({ notifyAwaySummary: vi.fn() }));

vi.mock("@tauri-apps/api/core", async () => ({ ...(await vi.importActual<object>("@tauri-apps/api/core")), invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", async () => ({
  ...(await vi.importActual<object>("@tauri-apps/api/event")),
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    tauri.handlers.set(name, handler);
    return Promise.resolve(() => tauri.handlers.delete(name));
  },
}));
vi.mock("../../lib/ipc", async () => ({ ...(await vi.importActual<object>("../../lib/ipc")), ...ipc }));
vi.mock("./notifications", () => notify);

function agent(partial: Partial<Agent>): Agent {
  return { id: "a", paneId: "p1", workspaceId: "ws", kind: "claude", state: "idle", sinceMs: 0, source: "hook", sessionId: null, ...partial };
}

describe("counting unseen and waiting work", () => {
  it("counts finished-unseen and waiting entries, an own agent and its hub session once", () => {
    const agents = [agent({ paneId: "p1", state: "done", sessionId: "s1" }), agent({ paneId: "p2", state: "blocked" }), agent({ paneId: "p3", state: "working" })];
    const sessions = [
      makeSession({ sessionId: "s1", paneId: "p1", state: "Idle", unseen: true }),
      makeSession({ sessionId: "out-1", state: "Idle", unseen: true }),
      makeSession({ sessionId: "out-2", state: "Idle", unseen: false }),
      makeSession({ sessionId: "out-3", state: "WaitingInput" }),
      makeSession({ sessionId: "out-4", state: "Error" }),
      makeSession({ sessionId: "out-5", state: "Ended", unseen: true }),
    ];
    expect(countUnseenWork(agents, sessions)).toEqual({ finished: 2, waiting: 3 });
    expect(countUnseenWork([], [])).toEqual({ finished: 0, waiting: 0 });
  });

  it("picks the badge tone: orange while anything waits, blue for finished only", () => {
    expect(taskbarBadge({ finished: 2, waiting: 1 })).toEqual({ count: 3, tone: "attention" });
    expect(taskbarBadge({ finished: 2, waiting: 0 })).toEqual({ count: 2, tone: "done" });
    expect(taskbarBadge({ finished: 0, waiting: 0 })).toEqual({ count: 0, tone: "done" });
  });
});

describe("away summary text", () => {
  const en = dictionary("en").agents.notification.away;
  const tr = dictionary("tr").agents.notification.away;

  it("is null when nothing is unseen or waiting", () => {
    expect(awaySummaryText({ finished: 0, waiting: 0 }, en)).toBeNull();
  });

  it("names both parts, skips a zero part and handles plurals (EN)", () => {
    expect(awaySummaryText({ finished: 2, waiting: 1 }, en)).toBe("While you were away: 2 finished, 1 needs you");
    expect(awaySummaryText({ finished: 1, waiting: 3 }, en)).toBe("While you were away: 1 finished, 3 need you");
    expect(awaySummaryText({ finished: 4, waiting: 0 }, en)).toBe("While you were away: 4 finished");
    expect(awaySummaryText({ finished: 0, waiting: 2 }, en)).toBe("While you were away: 2 need you");
  });

  it("builds the Turkish text", () => {
    expect(awaySummaryText({ finished: 2, waiting: 1 }, tr)).toBe("Sen yokken: 2 iş bitti, 1 iş seni bekliyor");
    expect(awaySummaryText({ finished: 1, waiting: 0 }, tr)).toBe("Sen yokken: 1 iş bitti");
    expect(awaySummaryText({ finished: 0, waiting: 5 }, tr)).toBe("Sen yokken: 5 iş seni bekliyor");
  });
});

describe("sessionsToMarkSeen", () => {
  const unseen = makeSession({ sessionId: "s1", paneId: "p1", state: "Idle", unseen: true });

  it("marks the hub session of a pane the desktop already counts as seen", () => {
    expect(sessionsToMarkSeen([agent({ state: "idle" })], [unseen])).toEqual([unseen]);
  });

  it("leaves it while the pane is still done, busy, heuristic or unrelated", () => {
    expect(sessionsToMarkSeen([agent({ state: "done" })], [unseen])).toEqual([]);
    expect(sessionsToMarkSeen([agent({ state: "working" })], [unseen])).toEqual([]);
    expect(sessionsToMarkSeen([agent({ state: "idle", source: "heuristic" })], [unseen])).toEqual([]);
    expect(sessionsToMarkSeen([agent({ paneId: "p9" })], [unseen])).toEqual([]);
    expect(sessionsToMarkSeen([agent({})], [{ ...unseen, unseen: false }])).toEqual([]);
  });
});

describe("validateHubSettings: unseen reminder", () => {
  const t = dictionary("en").settingsPage;
  const base = {
    rules: { contextThresholdPercent: 80, contextRearmPercent: 50, reminderAfter: "00:05:00", minTurnForCompleted: "00:00:30", unseenReminderEnabled: true, unseenReminderAfter: "00:30:00" },
    usageRules: { dailyCostThresholdUsd: 10 },
    quietHours: { start: "22:00", end: "08:00" },
    dictation: { hotkey: "Ctrl+Alt+D", pasteLastHotkey: "Ctrl+Alt+Shift+D", maxMinutes: 5 },
    buddy: { enabled: false, hotkey: "" },
    insights: { uncommittedThreshold: 20, dailySummaryTime: "18:00" },
  };
  const s = (rules: object) => ({ ...base, rules: { ...base.rules, ...rules } }) as unknown as HubSettings;

  it("accepts 1 minute to 1 day while on and ignores the value while off", () => {
    expect(validateHubSettings(s({}), t)["rules.unseenReminderAfter"]).toBeUndefined();
    expect(validateHubSettings(s({ unseenReminderAfter: "1.00:00:00" }), t)["rules.unseenReminderAfter"]).toBeUndefined();
    expect(validateHubSettings(s({ unseenReminderAfter: "00:00:30" }), t)["rules.unseenReminderAfter"]).toBe(t.rangeError(1, 1440));
    expect(validateHubSettings(s({ unseenReminderAfter: "invalid" }), t)["rules.unseenReminderAfter"]).toBe(t.rangeError(1, 1440));
    expect(validateHubSettings(s({ unseenReminderEnabled: false, unseenReminderAfter: "invalid" }), t)["rules.unseenReminderAfter"]).toBeUndefined();
  });
});

describe("installUnseenWork", () => {
  let dispose: () => void = () => {};
  const badges = () => tauri.invoke.mock.calls.filter((c) => c[0] === "taskbar_set_badge").map((c) => c[1]);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    tauri.invoke.mockReset().mockResolvedValue(null);
    tauri.handlers.clear();
    ipc.hubRequest.mockReset().mockResolvedValue(null);
    notify.notifyAwaySummary.mockReset().mockResolvedValue(undefined);
    useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
    useAgentStore.setState({ agents: [] });
    useHubStore.setState({ sessions: [], connected: true });
    useMascotSettingsStore.setState({ settings: null });
    dispose = installUnseenWork();
  });

  afterEach(() => dispose());

  it("sends the badge only when it changes", () => {
    expect(badges()).toEqual([{ count: 0, tone: "done", description: "" }]);
    useHubStore.setState({ sessions: [makeSession({ sessionId: "o1", state: "Idle", unseen: true })] });
    useHubStore.setState({ sessions: [makeSession({ sessionId: "o1", state: "Idle", unseen: true })] });
    useHubStore.setState({ sessions: [makeSession({ sessionId: "o1", state: "Idle", unseen: true }), makeSession({ sessionId: "o2", state: "WaitingPermission" })] });
    expect(badges()).toEqual([
      { count: 0, tone: "done", description: "" },
      { count: 1, tone: "done", description: "1 finished" },
      { count: 2, tone: "attention", description: "1 finished, 1 needs attention" },
    ]);
  });

  it("marks an own pane's hub session seen once the desktop counts it seen", () => {
    useHubStore.setState({ sessions: [makeSession({ sessionId: "s1", agent: "codex", paneId: "p1", state: "Idle", unseen: true })] });
    useAgentStore.setState({ agents: [agent({ state: "done" })] });
    expect(ipc.hubRequest).not.toHaveBeenCalled();
    useAgentStore.setState({ agents: [agent({ state: "idle" })] });
    expect(ipc.hubRequest).toHaveBeenCalledWith("POST", "/v1/sessions/codex/s1/seen");
    expect(useHubStore.getState().sessions[0]!.unseen).toBe(false);
  });

  it("sends one away summary when something is unseen or waiting", async () => {
    tauri.handlers.get("user:returned")!({ payload: { awayMs: 900_000 } });
    await flush();
    expect(notify.notifyAwaySummary).not.toHaveBeenCalled();

    ipc.hubRequest.mockResolvedValue({ doNotDisturbUntil: null, quietHours: { enabled: false, start: "22:00", end: "08:00" } });
    useHubStore.setState({ sessions: [makeSession({ sessionId: "o1", state: "Idle", unseen: true }), makeSession({ sessionId: "o2", state: "WaitingInput" })] });
    tauri.handlers.get("user:returned")!({ payload: { awayMs: 900_000 } });
    await flush();
    expect(notify.notifyAwaySummary).toHaveBeenCalledWith({ finished: 1, waiting: 1 });
  });

  it("stays quiet in do not disturb or with the summary off", async () => {
    useHubStore.setState({ sessions: [makeSession({ sessionId: "o1", state: "Idle", unseen: true })] });
    ipc.hubRequest.mockResolvedValue({ doNotDisturbUntil: new Date(Date.now() + 3_600_000).toISOString(), quietHours: { enabled: false, start: "22:00", end: "08:00" } });
    tauri.handlers.get("user:returned")!({ payload: { awayMs: 900_000 } });
    await flush();
    expect(notify.notifyAwaySummary).not.toHaveBeenCalled();

    ipc.hubRequest.mockResolvedValue({ doNotDisturbUntil: null, quietHours: { enabled: false, start: "22:00", end: "08:00" } });
    useSettingsStore.setState({ settings: { ...structuredClone(DEFAULT_SETTINGS), agents: { ...DEFAULT_SETTINGS.agents, awaySummary: false } } });
    tauri.handlers.get("user:returned")!({ payload: { awayMs: 900_000 } });
    await flush();
    expect(notify.notifyAwaySummary).not.toHaveBeenCalled();
  });
});
