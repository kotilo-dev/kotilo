import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubSettings } from "../../lib/hubTypes";
import { useRouteStore } from "../../stores/routeStore";
import { useSettingsPageStore } from "../settings/SettingsPage";
import { useMascotSettingsStore } from "../settings/mascotSettings";
import { installAssistantBridge, useAssistantHotkeyStore } from "./useAssistantBridge";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", async () => ({ ...(await vi.importActual<object>("@tauri-apps/api/core")), invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", async () => ({
  ...(await vi.importActual<object>("@tauri-apps/api/event")),
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    tauri.handlers.set(name, handler);
    return Promise.resolve(() => tauri.handlers.delete(name));
  },
}));

const settings = (buddy: Partial<HubSettings["buddy"]>) =>
  ({ buddy: { enabled: true, hotkey: "Ctrl+Alt+Space", mascotEnabled: false, ...buddy } }) as unknown as HubSettings;

const configCalls = () => tauri.invoke.mock.calls.filter(([cmd]) => cmd === "assistant_set_config").map(([, args]) => args);

describe("useAssistantBridge", () => {
  let dispose: () => void = () => {};

  beforeEach(() => {
    tauri.invoke.mockReset().mockResolvedValue(undefined);
    tauri.handlers.clear();
    useMascotSettingsStore.setState({ settings: null });
    useAssistantHotkeyStore.setState({ status: null });
  });

  afterEach(() => dispose());

  it("sends the config once settings are there and again when they change", () => {
    dispose = installAssistantBridge();
    expect(configCalls()).toEqual([]);
    useMascotSettingsStore.setState({ settings: settings({}) });
    expect(configCalls()).toEqual([{ config: { enabled: true, hotkey: "Ctrl+Alt+Space" } }]);
    // A mascot-only change sends nothing new.
    useMascotSettingsStore.setState({ settings: settings({ mascotEnabled: true }) });
    expect(configCalls()).toHaveLength(1);
    useMascotSettingsStore.setState({ settings: settings({ enabled: false }) });
    useMascotSettingsStore.setState({ settings: settings({ enabled: false, hotkey: "Ctrl+Alt+K" }) });
    expect(configCalls().slice(1)).toEqual([{ config: { enabled: false, hotkey: "Ctrl+Alt+Space" } }, { config: { enabled: false, hotkey: "Ctrl+Alt+K" } }]);
  });

  it("sends at once when settings were already loaded", () => {
    useMascotSettingsStore.setState({ settings: settings({ enabled: false }) });
    dispose = installAssistantBridge();
    expect(configCalls()).toEqual([{ config: { enabled: false, hotkey: "Ctrl+Alt+Space" } }]);
  });

  it("keeps the status assistant_set_config returns, tied to the saved shortcut text", async () => {
    tauri.invoke.mockResolvedValue({ status: "invalid", hotkey: "Ctrl+Alt+Q" });
    dispose = installAssistantBridge();
    useMascotSettingsStore.setState({ settings: settings({ hotkey: "alt+ctrl+q" }) });
    await vi.waitFor(() => expect(useAssistantHotkeyStore.getState().status).toEqual({ status: "invalid", hotkey: "Ctrl+Alt+Q", configured: "alt+ctrl+q" }));
  });

  it("keeps the shortcut status from Rust", () => {
    useMascotSettingsStore.setState({ settings: settings({}) });
    dispose = installAssistantBridge();
    tauri.handlers.get("assistant:hotkey")!({ payload: { status: "taken", hotkey: "Ctrl+Alt+Space" } });
    expect(useAssistantHotkeyStore.getState().status).toEqual({ status: "taken", hotkey: "Ctrl+Alt+Space", configured: "Ctrl+Alt+Space" });
    tauri.handlers.get("assistant:hotkey")!({ payload: { status: "bogus" } });
    expect(useAssistantHotkeyStore.getState().status?.status).toBe("taken");
  });

  it("opens Settings → AI when the popup asks", () => {
    dispose = installAssistantBridge();
    useRouteStore.getState().navigate("overview");
    tauri.handlers.get("assistant:settings")!({ payload: null });
    expect(useRouteStore.getState().route).toBe("settings");
    expect(useSettingsPageStore.getState().section).toBe("ai");
  });
});
