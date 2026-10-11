import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../lib/ipc";
import type { HubSettings, SessionDto, UsageCurrent } from "../../lib/hubTypes";
import { strings } from "../../app/strings";
import { useAgentStore } from "../../stores/agentStore";
import { useHubStore } from "../../stores/hubStore";
import { useRouteStore } from "../../stores/routeStore";
import { useSettingsPageStore } from "../settings/SettingsPage";
import { useMascotSettingsStore } from "../settings/mascotSettings";
import { BURN_RULE_ID, installMascotBridge } from "./useMascotBridge";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
}));
const ipc = vi.hoisted(() => ({ hubRequest: vi.fn() }));
const nav = vi.hoisted(() => ({ navigateToAgent: vi.fn() }));

vi.mock("@tauri-apps/api/core", async () => ({ ...(await vi.importActual<object>("@tauri-apps/api/core")), invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", async () => ({
  ...(await vi.importActual<object>("@tauri-apps/api/event")),
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    tauri.handlers.set(name, handler);
    return Promise.resolve(() => tauri.handlers.delete(name));
  },
}));
vi.mock("../../lib/ipc", async () => ({ ...(await vi.importActual<object>("../../lib/ipc")), ...ipc }));
vi.mock("../agents/navigate", () => nav);

const NOW = Date.parse("2026-10-11T12:00:00Z");

const SETTINGS = {
  language: "en-US",
  rules: { minTurnForCompleted: "00:00:30" },
  quietHours: { enabled: false, start: "22:00:00", end: "08:00:00" },
  doNotDisturbUntil: null,
  buddy: {
    enabled: false,
    mascotEnabled: true,
    mascotOffered: true,
    hotkey: "Ctrl+Alt+B",
    mascotScale: 3,
    walkArea: "taskbar",
    celebrate: true,
    showBuddySessions: false,
    mascotHiddenUntil: null,
    mascotPosition: 0.5,
  },
} as unknown as HubSettings;

function agent(partial: Partial<Agent>): Agent {
  return { id: "a", paneId: "pane-a", workspaceId: "ws", kind: "claude", state: "idle", sinceMs: NOW - 60_000, source: "hook", sessionId: null, ...partial };
}

function session(partial: Partial<SessionDto>): SessionDto {
  return {
    sessionId: "s",
    agent: "codex",
    paneId: null,
    projectRoot: "C:/src/app",
    projectName: "app",
    state: "Working",
    stateSince: new Date(NOW - 60_000).toISOString(),
    lastEventAt: new Date(NOW).toISOString(),
    currentTool: null,
    model: null,
    tokens: 0,
    costUsd: null,
    contextUsedPercent: null,
    turnStartedAt: null,
    endedAt: null,
    activeSubagents: 0,
    lastNotification: null,
    error: null,
    tasks: null,
    pendingPermission: null,
    ...partial,
  };
}

/** Last `mascot_update` / `mascot_set_config` payload. */
function lastCall(command: string): Record<string, unknown> | undefined {
  const calls = tauri.invoke.mock.calls.filter((c) => c[0] === command);
  return calls[calls.length - 1]?.[1] as Record<string, unknown> | undefined;
}

const flush = async (ms = 200) => {
  await vi.advanceTimersByTimeAsync(ms);
};

let dispose: () => void = () => {};

describe("mascot bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    tauri.invoke.mockReset().mockResolvedValue(null);
    tauri.handlers.clear();
    nav.navigateToAgent.mockReset();
    let stored = structuredClone(SETTINGS);
    ipc.hubRequest.mockReset().mockImplementation((method: string, _path: string, body?: unknown) => {
      if (method === "PUT") stored = structuredClone(body as HubSettings);
      return Promise.resolve(structuredClone(stored));
    });
    useAgentStore.setState({ agents: [] });
    useHubStore.setState({ sessions: [], usage: null, connected: true });
    useMascotSettingsStore.setState({ settings: structuredClone(SETTINGS), offerVisible: false });
    useRouteStore.getState().navigate("workspace");
    dispose = installMascotBridge();
  });

  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  it("adds the Open assistant menu label while the assistant is on (M7)", async () => {
    await flush();
    expect((lastCall("mascot_set_config")!.config as { labels: object }).labels).not.toHaveProperty("openAssistant");
    useMascotSettingsStore.setState({ settings: { ...structuredClone(SETTINGS), buddy: { ...SETTINGS.buddy, enabled: true } } });
    await flush();
    expect((lastCall("mascot_set_config")!.config as { labels: object }).labels).toMatchObject({ openAssistant: strings.assistant.openFromMascot });
  });

  it("sends the config with labels and the state once it changes", async () => {
    await flush();
    expect(lastCall("mascot_set_config")).toEqual({
      config: {
        enabled: true,
        scale: 3,
        walkArea: "taskbar",
        celebrate: true,
        position: 0.5,
        labels: { aria: strings.mascot.aria, hideHour: strings.mascot.hideHour, turnOff: strings.mascot.turnOff, settings: strings.mascot.openSettings },
      },
    });
    expect(lastCall("mascot_update")).toEqual({ update: { state: "sleep", speed: 1 } });

    useAgentStore.setState({ agents: [agent({ paneId: "p1", state: "working" }), agent({ paneId: "p2", state: "working" })] });
    await flush();
    expect(lastCall("mascot_update")).toEqual({ update: { state: "work", speed: 1.15 } });

    const updates = tauri.invoke.mock.calls.filter((c) => c[0] === "mascot_update").length;
    await flush(3_000);
    expect(tauri.invoke.mock.calls.filter((c) => c[0] === "mascot_update")).toHaveLength(updates);
  });

  it("celebrates a finished long turn for three seconds", async () => {
    useAgentStore.setState({ agents: [agent({ paneId: "p1", state: "working", sinceMs: NOW - 60_000 })] });
    await flush();
    useAgentStore.setState({ agents: [agent({ paneId: "p1", state: "idle" })] });
    await flush();
    expect(lastCall("mascot_update")).toEqual({ update: { state: "done", speed: 1 } });
    await flush(4_500); // next 1 s tick after the 3 s are over, plus the debounce
    expect(lastCall("mascot_update")).toEqual({ update: { state: "sleep", speed: 1 } });
  });

  it("sweats after the burn warning for the active block", async () => {
    const usage = { activeBlock: { start: new Date(NOW - 3_600_000).toISOString(), end: new Date(NOW + 3_600_000).toISOString() } } as unknown as UsageCurrent;
    useHubStore.setState({ usage, sessions: [session({ sessionId: "h1" })] });
    useHubStore.getState().apply({ type: "notification", data: { ruleId: BURN_RULE_ID } as never });
    await flush();
    expect(lastCall("mascot_update")).toEqual({ update: { state: "sweat", speed: 1 } });
  });

  it("sleeps in do not disturb", async () => {
    useAgentStore.setState({ agents: [agent({ paneId: "p1", state: "blocked" })] });
    useMascotSettingsStore.setState({ settings: { ...SETTINGS, doNotDisturbUntil: new Date(NOW + 60_000).toISOString() } });
    await flush();
    expect(lastCall("mascot_update")).toEqual({ update: { state: "sleep", speed: 1 } });
  });

  it("a click on perm goes to the agent waiting longest; sweat opens Usage", async () => {
    const old = agent({ paneId: "old", state: "blocked", sinceMs: NOW - 90_000 });
    useAgentStore.setState({ agents: [agent({ paneId: "new", state: "blocked", sinceMs: NOW - 5_000 }), old] });
    await flush();
    tauri.handlers.get("mascot:clicked")?.({ payload: { state: "perm" } });
    expect(nav.navigateToAgent).toHaveBeenCalledWith(old);

    tauri.handlers.get("mascot:clicked")?.({ payload: { state: "sweat" } });
    expect(useRouteStore.getState().route).toBe("usage");
  });

  it("menu actions save buddy settings or open the Mascot section; drag saves the position", async () => {
    tauri.handlers.get("mascot:menu")?.({ payload: { action: "hideHour" } });
    await flush();
    expect(Date.parse(useMascotSettingsStore.getState().settings!.buddy.mascotHiddenUntil!)).toBe(NOW + 3_600_000);
    expect(lastCall("mascot_set_config")).toMatchObject({ config: { enabled: false } });

    // The config is sent again when "hidden until" passes.
    await flush(3_600_100);
    expect(lastCall("mascot_set_config")).toMatchObject({ config: { enabled: true } });

    tauri.handlers.get("mascot:position")?.({ payload: { position: 0.25 } });
    tauri.handlers.get("mascot:menu")?.({ payload: { action: "turnOff" } });
    await flush();
    expect(useMascotSettingsStore.getState().settings!.buddy).toMatchObject({ mascotEnabled: false, mascotPosition: 0.25 });

    tauri.handlers.get("mascot:menu")?.({ payload: { action: "settings" } });
    expect(useRouteStore.getState().route).toBe("settings");
    expect(useSettingsPageStore.getState().section).toBe("mascot");
  });

  it("offers the mascot once when something starts working while it is off", async () => {
    useMascotSettingsStore.setState({ settings: { ...SETTINGS, buddy: { ...SETTINGS.buddy, mascotEnabled: false, mascotOffered: false } } });
    await flush();
    expect(useMascotSettingsStore.getState().offerVisible).toBe(false);

    useHubStore.setState({ sessions: [session({ sessionId: "h1" })] });
    expect(useMascotSettingsStore.getState().offerVisible).toBe(true);

    await useMascotSettingsStore.getState().answerOffer(true);
    expect(useMascotSettingsStore.getState()).toMatchObject({ offerVisible: false, settings: { buddy: { mascotEnabled: true, mascotOffered: true } } });
  });
});
