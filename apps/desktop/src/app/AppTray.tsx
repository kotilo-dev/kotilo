/**
 * D-058: the tray icon, present only while Settings → About "keep running in the tray" is on.
 * Closing the window then only hides it (`CloseGuard`); a left click or "Show" brings it back,
 * "Quit" goes through the normal close path. Rebuilt when the language changes.
 */
import { useEffect } from "react";
import { defaultWindowIcon } from "@tauri-apps/api/app";
import { Menu } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { APP_NAME } from "./constants";
import { requestQuit, showMainWindow } from "./CloseGuard";
import { useStrings } from "./strings";
import { logWarn, oneLineMessage } from "../lib/logging";
import { useSettingsStore } from "../stores/settingsStore";

export function AppTray() {
  const s = useStrings();
  const enabled = useSettingsStore((st) => st.settings.window?.closeToTray === true);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let tray: TrayIcon | undefined;
    void (async () => {
      try {
        const menu = await Menu.new({
          items: [
            { id: "show", text: s.tray.show, action: () => void showMainWindow() },
            { id: "quit", text: s.tray.quit, action: () => void requestQuit() },
          ],
        });
        const created = await TrayIcon.new({
          menu,
          icon: (await defaultWindowIcon()) ?? undefined,
          tooltip: APP_NAME,
          showMenuOnLeftClick: false,
          action: (e) => {
            if (e.type === "Click" && e.button === "Left" && e.buttonState === "Up") void showMainWindow();
          },
        });
        if (disposed) void created.close();
        else tray = created;
      } catch (e) {
        logWarn(`tray: could not create the icon: ${oneLineMessage(e)}`);
      }
    })();
    return () => {
      disposed = true;
      void tray?.close();
    };
  }, [enabled, s]);

  return null;
}
