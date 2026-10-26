/**
 * Keeps `<html data-theme>`, the colour theme's CSS variables and `useResolvedTheme` in sync with
 * the mode + `appearance` settings and, for "system", with the OS light/dark preference
 * (faz6-spec §2/§10.11, D-057). `main.tsx` applies the theme once before the first render; this
 * follows later changes.
 */
import { useSettingsStore } from "../../stores/settingsStore";
import { applyAppearance } from "./applyTheme";

export function installThemeSync(root: HTMLElement = document.documentElement): () => void {
  const media = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const apply = () => {
    applyAppearance(useSettingsStore.getState().settings, media ? media.matches : true, root);
  };
  apply();
  const unsubscribe = useSettingsStore.subscribe((state, prev) => {
    const s = state.settings;
    const p = prev.settings;
    if (s.theme !== p.theme || s.appearance?.darkTheme !== p.appearance?.darkTheme || s.appearance?.lightTheme !== p.appearance?.lightTheme || s.appearance?.windowOpacity !== p.appearance?.windowOpacity) apply();
  });
  media?.addEventListener("change", apply);
  return () => {
    unsubscribe();
    media?.removeEventListener("change", apply);
  };
}
