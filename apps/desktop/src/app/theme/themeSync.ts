/**
 * Keeps `<html data-theme>` and `useResolvedTheme` in sync with the theme setting and, for
 * "system", with the OS light/dark preference (faz6-spec §2/§10.11). `main.tsx` sets the
 * attribute once before the first render; this follows later changes.
 */
import { useSettingsStore } from "../../stores/settingsStore";
import { resolveTheme, useResolvedTheme } from "./resolvedTheme";

export function installThemeSync(root: HTMLElement = document.documentElement): () => void {
  const media = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const apply = () => {
    const theme = resolveTheme(useSettingsStore.getState().settings.theme, media ? media.matches : true);
    root.dataset.theme = theme;
    if (useResolvedTheme.getState().theme !== theme) useResolvedTheme.setState({ theme });
  };
  apply();
  const unsubscribe = useSettingsStore.subscribe((state, prev) => {
    if (state.settings.theme !== prev.settings.theme) apply();
  });
  media?.addEventListener("change", apply);
  return () => {
    unsubscribe();
    media?.removeEventListener("change", apply);
  };
}
