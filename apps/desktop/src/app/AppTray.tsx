/**
 * D-058 / D-075: the tray icon, always present. Its menu and tooltip carry a usage summary
 * (today, the active 5-hour block, plan limits) and the sessions waiting for the user; a click
 * on one opens it. Closing the window hides it only while "keep running in the tray" is on
 * (`CloseGuard`); a left click or "Show" brings it back, "Quit" goes through the normal close path.
 */
import { useEffect, useRef, useState } from "react";
import { defaultWindowIcon } from "@tauri-apps/api/app";
import { Menu } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { APP_NAME } from "./constants";
import { requestQuit, showMainWindow } from "./CloseGuard";
import { useStrings, type Strings } from "./strings";
import { traySummary, type TraySummary } from "./traySummary";
import { useStateLabel } from "./ui/StatusPill";
import { goToSession } from "../features/mission/MissionControlPage";
import { logWarn, oneLineMessage } from "../lib/logging";
import { useHubStore } from "../stores/hubStore";
import { useRouteStore } from "../stores/routeStore";

/** The stream updates usage every few seconds; the menu follows at most this often. */
const UPDATE_THROTTLE_MS = 5_000;

export function AppTray() {
  const s = useStrings();
  const stateLabel = useStateLabel();
  const connected = useHubStore((st) => st.connected);
  const usage = useHubStore((st) => st.usage);
  const limits = useHubStore((st) => st.limits);
  const sessions = useHubStore((st) => st.sessions);
  const [tray, setTray] = useState<TrayIcon | null>(null);

  useEffect(() => {
    let disposed = false;
    let created: TrayIcon | undefined;
    void (async () => {
      try {
        created = await TrayIcon.new({
          icon: (await defaultWindowIcon()) ?? undefined,
          tooltip: APP_NAME,
          showMenuOnLeftClick: false,
          action: (e) => {
            if (e.type === "Click" && e.button === "Left" && e.buttonState === "Up") void showMainWindow();
          },
        });
        if (disposed) void created.close();
        else setTray(created);
      } catch (e) {
        logWarn(`tray: could not create the icon: ${oneLineMessage(e)}`);
      }
    })();
    return () => {
      disposed = true;
      void created?.close();
    };
  }, []);

  const summary = traySummary({ connected, usage, limits, sessions }, s, APP_NAME, stateLabel);
  const latest = useRef({ summary, s });
  latest.current = { summary, s };
  const applied = useRef<{ signature: string; at: number; menu: Menu | null }>({ signature: "", at: 0, menu: null });

  useEffect(() => {
    if (!tray || summary.signature === applied.current.signature) return;
    const wait = Math.max(0, applied.current.at + UPDATE_THROTTLE_MS - Date.now());
    const timer = setTimeout(() => {
      const { summary: now, s: strings } = latest.current;
      if (now.signature === applied.current.signature) return;
      applied.current = { ...applied.current, signature: now.signature, at: Date.now() };
      void applySummary(tray, now, strings, applied);
    }, wait);
    return () => clearTimeout(timer);
  }, [tray, summary.signature]);

  return null;
}

async function applySummary(
  tray: TrayIcon,
  summary: TraySummary,
  s: Strings,
  applied: { current: { signature: string; at: number; menu: Menu | null } },
): Promise<void> {
  try {
    const waiting = summary.waiting.map((w) => ({
      id: `waiting:${w.key}`,
      text: w.label,
      action: () => {
        void showMainWindow();
        goToSession(w.session);
      },
    }));
    const more =
      summary.moreWaiting > 0
        ? [
            {
              id: "waiting:more",
              text: s.tray.moreWaiting(summary.moreWaiting),
              action: () => {
                void showMainWindow();
                useRouteStore.getState().navigate("mission");
              },
            },
          ]
        : [];
    const menu = await Menu.new({
      items: [
        ...summary.lines.map((text, i) => ({ id: `info:${i}`, text, enabled: false })),
        ...(waiting.length > 0
          ? [{ item: "Separator" as const }, { id: "waiting:title", text: s.tray.waiting, enabled: false }, ...waiting, ...more]
          : []),
        { item: "Separator" as const },
        { id: "show", text: s.tray.show, action: () => void showMainWindow() },
        { id: "quit", text: s.tray.quit, action: () => void requestQuit() },
      ],
    });
    await tray.setMenu(menu);
    const old = applied.current.menu;
    applied.current.menu = menu;
    void old?.close();
    // Linux trays have no tooltip; the menu carries the same lines.
    await tray.setTooltip(summary.tooltip).catch(() => undefined);
  } catch (e) {
    logWarn(`tray: could not update the menu: ${oneLineMessage(e)}`);
  }
}
