/**
 * M7: the main window's side of the assistant popup. Sends `buddy.enabled` / `buddy.hotkey`
 * to Rust (`assistant_set_config`) at startup and whenever they change, keeps the shortcut's
 * registration status for Settings (`assistant:hotkey`) and opens Settings → AI when the popup
 * asks for it (`assistant:settings`). Mounted once in `App.tsx`.
 */
import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { useRouteStore } from "../../stores/routeStore";
import { useSettingsPageStore } from "../settings/SettingsPage";
import { useMascotSettingsStore } from "../settings/mascotSettings";
import { ASSISTANT_HOTKEY_EVENT, ASSISTANT_SETTINGS_EVENT, assistantSetConfig, type AssistantConfig, type HotkeyStatus } from "./assistantIpc";

/** A shortcut report from Rust, tied to the `buddy.hotkey` text it was about. */
export interface HotkeyReport {
  status: HotkeyStatus;
  /** As Rust normalised it (e.g. "Ctrl+Alt+Space"). */
  hotkey: string;
  /** The saved `buddy.hotkey` that was sent (what the Settings field shows). */
  configured: string;
}

interface HotkeyState {
  /** Last report from Rust (null = none yet). */
  status: HotkeyReport | null;
  set: (status: HotkeyReport) => void;
}

export const useAssistantHotkeyStore = create<HotkeyState>((set) => ({
  status: null,
  set: (status) => set({ status }),
}));

function isHotkeyStatus(v: unknown): v is HotkeyStatus {
  return v === "ok" || v === "taken" || v === "invalid" || v === "off";
}

export function useAssistantBridge(): void {
  useEffect(() => installAssistantBridge(), []);
}

export function installAssistantBridge(): () => void {
  let sent = "";
  let configured = useMascotSettingsStore.getState().settings?.buddy.hotkey ?? "";
  let disposed = false;

  function report(payload: { status?: unknown; hotkey?: unknown } | null | undefined): void {
    const { status, hotkey } = payload ?? {};
    if (!isHotkeyStatus(status) || disposed) return;
    useAssistantHotkeyStore.getState().set({ status, hotkey: typeof hotkey === "string" ? hotkey : "", configured });
  }

  function sendConfig(): void {
    const buddy = useMascotSettingsStore.getState().settings?.buddy;
    if (!buddy || disposed) return;
    const config: AssistantConfig = { enabled: buddy.enabled, hotkey: buddy.hotkey };
    const key = JSON.stringify(config);
    if (key === sent) return;
    sent = key;
    configured = buddy.hotkey;
    assistantSetConfig(config).then(report, () => {
      sent = "";
    });
  }

  const unsubscribe = useMascotSettingsStore.subscribe((s, prev) => {
    if (s.settings?.buddy !== prev.settings?.buddy) sendConfig();
  });

  const unlistenPromises: Promise<UnlistenFn>[] = [
    listen<{ status?: unknown; hotkey?: unknown }>(ASSISTANT_HOTKEY_EVENT, (e) => report(e.payload)),
    listen(ASSISTANT_SETTINGS_EVENT, () => {
      useSettingsPageStore.getState().setSection("ai");
      useRouteStore.getState().navigate("settings");
    }),
  ];

  // The mascot bridge loads the hub settings; send as soon as they are there.
  sendConfig();

  return () => {
    disposed = true;
    unsubscribe();
    for (const p of unlistenPromises) void p.then((u) => u()).catch(() => {});
  };
}
