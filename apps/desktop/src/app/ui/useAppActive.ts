/**
 * 0.3.2: false while the window is unfocused or the document hidden (minimized, tray), so
 * 1 s display timers stop re-rendering nobody-sees UI. DOM focus/blur follow the native
 * window's focus in the WebView, so no Tauri call is needed (works in tests and e2e too).
 */
import { useEffect, useState } from "react";

function visible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export function useAppActive(): boolean {
  const [focused, setFocused] = useState(true);
  const [shown, setShown] = useState(visible);
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    const onVisibility = () => setShown(visible());
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return focused && shown;
}
