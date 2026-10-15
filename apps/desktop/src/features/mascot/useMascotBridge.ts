/**
 * M6: the main window's side of the mascot. Combines own agents + hub sessions into one state
 * (`mascotLogic.ts`) and sends it to Rust (`mascot_update`), sends the config (`mascot_set_config`)
 * and reacts to the mascot window's click / menu / drag events. Mounted once in `App.tsx`.
 */
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { strings } from "../../app/strings";
import { useI18nStore } from "../../app/i18n";
import { useAgentStore } from "../../stores/agentStore";
import { observeHubNotifications, useHubStore } from "../../stores/hubStore";
import { useRouteStore } from "../../stores/routeStore";
import { navigateToAgent } from "../agents/navigate";
import { goToSession } from "../mission/MissionControlPage";
import { useSettingsPageStore } from "../settings/SettingsPage";
import { useMascotSettingsStore } from "../settings/mascotSettings";
import { parseTimeSpan } from "../settings/hubSettings";
import {
  clickTarget,
  finishedLongTurn,
  hiddenUntilMs,
  isBurning,
  isDoNotDisturb,
  mascotConfig,
  mergeEntries,
  resolveMascotState,
  shouldOffer,
  speedFactor,
  type MascotEntry,
  type MascotState,
} from "./mascotLogic";

const UPDATE_DEBOUNCE_MS = 150;
const TICK_MS = 1_000;
/** Picks up DND / quiet hour changes made outside the Settings page. */
const SETTINGS_RELOAD_MS = 120_000;
const HIDE_MS = 3_600_000;
/** Hub default of `rules.minTurnForCompleted` (30 s) while settings aren't loaded. */
const DEFAULT_MIN_TURN_MS = 30_000;

export const BURN_RULE_ID = "usage.burn_projection";

type MenuAction = "hideHour" | "turnOff" | "settings";

export function useMascotBridge(): void {
  useEffect(() => installMascotBridge(), []);
}

function goToEntry(entry: MascotEntry): void {
  if (entry.agent) navigateToAgent(entry.agent);
  else if (entry.session?.paneId) goToSession(entry.session);
  else useRouteStore.getState().navigate("mission");
}

/** Installs every listener and timer; returns the cleanup. */
export function installMascotBridge(): () => void {
  let entries: MascotEntry[] = [];
  let state: MascotState = "sleep";
  let lastCompletedAt: number | null = null;
  let burnBlockStart: string | null = null;
  let sentUpdate = "";
  let sentConfig = "";
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const settings = () => useMascotSettingsStore.getState().settings;

  function recompute(): void {
    const now = Date.now();
    const next = mergeEntries(useAgentStore.getState().agents, useHubStore.getState().sessions);
    const s = settings();
    const minTurn = s ? (parseTimeSpan(s.rules.minTurnForCompleted) ?? 30) * 1_000 : DEFAULT_MIN_TURN_MS;
    if (finishedLongTurn(entries, next, minTurn, now)) lastCompletedAt = now;
    entries = next;

    state = resolveMascotState(
      {
        entries,
        burn: isBurning(burnBlockStart, useHubStore.getState().usage, now),
        lastCompletedAt,
        doNotDisturb: s ? isDoNotDisturb(s.doNotDisturbUntil, s.quietHours, new Date(now)) : false,
        celebrate: s?.buddy.celebrate ?? true,
      },
      now,
    );
    scheduleUpdate({ state, speed: speedFactor(entries) });

    if (s && shouldOffer(s.buddy, entries)) useMascotSettingsStore.getState().showOffer();
  }

  function scheduleUpdate(update: { state: MascotState; speed: number }): void {
    const key = JSON.stringify(update);
    if (key === sentUpdate) {
      clearTimeout(updateTimer);
      updateTimer = undefined;
      return;
    }
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      if (disposed) return;
      sentUpdate = key;
      void invoke("mascot_update", { update }).catch(() => {});
    }, UPDATE_DEBOUNCE_MS);
  }

  function sendConfig(): void {
    const s = settings();
    if (!s || disposed) return;
    const now = Date.now();
    const config = mascotConfig(
      s.buddy,
      {
        aria: strings.mascot.aria,
        hideHour: strings.mascot.hideHour,
        turnOff: strings.mascot.turnOff,
        settings: strings.mascot.openSettings,
        ...(s.buddy.enabled ? { openAssistant: strings.assistant.openFromMascot } : {}),
      },
      now,
    );
    // Re-send when "hidden until" passes.
    clearTimeout(hiddenTimer);
    const until = hiddenUntilMs(s.buddy, now);
    if (until !== null) hiddenTimer = setTimeout(sendConfig, until - now + 50);
    const key = JSON.stringify(config);
    if (key === sentConfig) return;
    sentConfig = key;
    void invoke("mascot_set_config", { config }).catch(() => {});
    // A fresh config may have (re)created the mascot window: give it the current state too.
    sentUpdate = "";
    recompute();
  }

  function onClicked(clicked: MascotState): void {
    const target = clickTarget(clicked, entries);
    if (target.kind === "entry") goToEntry(target.entry);
    else if (target.kind === "usage") useRouteStore.getState().navigate("usage");
  }

  function onMenu(action: MenuAction): void {
    const store = useMascotSettingsStore.getState();
    switch (action) {
      case "hideHour":
        void store.saveBuddy((b) => ({ ...b, mascotHiddenUntil: new Date(Date.now() + HIDE_MS).toISOString() }));
        break;
      case "turnOff":
        void store.saveBuddy((b) => ({ ...b, mascotEnabled: false }));
        break;
      case "settings":
        useSettingsPageStore.getState().setSection("mascot");
        useRouteStore.getState().navigate("settings");
        break;
    }
  }

  const unsubscribers: (() => void)[] = [
    useAgentStore.subscribe((s, prev) => {
      if (s.agents !== prev.agents) recompute();
    }),
    useHubStore.subscribe((s, prev) => {
      if (s.sessions !== prev.sessions || s.usage !== prev.usage) recompute();
      if (s.connected && !prev.connected) void useMascotSettingsStore.getState().load();
    }),
    useMascotSettingsStore.subscribe((s, prev) => {
      if (s.settings !== prev.settings) {
        sendConfig();
        recompute();
      }
    }),
    useI18nStore.subscribe((s, prev) => {
      if (s.language !== prev.language) sendConfig();
    }),
    observeHubNotifications((n) => {
      if (n.ruleId !== BURN_RULE_ID) return;
      burnBlockStart = useHubStore.getState().usage?.activeBlock?.start ?? null;
      recompute();
    }),
  ];

  const unlistenPromises: Promise<UnlistenFn>[] = [
    listen<{ state: MascotState }>("mascot:clicked", (e) => onClicked(e.payload.state)),
    listen<{ action: MenuAction }>("mascot:menu", (e) => onMenu(e.payload.action)),
    listen<{ position: number }>("mascot:position", (e) => {
      const position = Math.min(1, Math.max(0, Number(e.payload.position)));
      if (!Number.isFinite(position)) return;
      void useMascotSettingsStore.getState().saveBuddy((b) => ({ ...b, mascotPosition: position }));
    }),
  ];

  // Done expires, DND / quiet hours and usage blocks change with time alone. Not while the
  // mascot is off: store changes still recompute (the "turn it on?" offer needs them). The main
  // window's focus does not matter here: the mascot is meant to be seen from other windows.
  const tick = setInterval(() => {
    if (settings()?.buddy.mascotEnabled === false) return;
    recompute();
  }, TICK_MS);
  const reload = setInterval(() => void useMascotSettingsStore.getState().load(), SETTINGS_RELOAD_MS);

  if (settings()) sendConfig();
  else void useMascotSettingsStore.getState().load();
  recompute();

  return () => {
    disposed = true;
    unsubscribers.forEach((u) => u());
    for (const p of unlistenPromises) void p.then((u) => u()).catch(() => {});
    clearInterval(tick);
    clearInterval(reload);
    clearTimeout(updateTimer);
    clearTimeout(hiddenTimer);
  };
}
