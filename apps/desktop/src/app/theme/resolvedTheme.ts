/**
 * The theme actually shown: the mode setting ("system" resolved from the OS preference) picks
 * `appearance.darkTheme` or `appearance.lightTheme` (D-057); unknown or terminal-only ids fall
 * back to Kotilo. Everything that paints (tokens via `<html data-theme>` + the CSS variables set
 * by `applyTheme.ts`, Monaco, highlight.js, xterm) reads this, never the raw setting. `theme` is
 * the variant's kind (dark/light), `id` the catalogue id.
 */
import { create } from "zustand";
import type { Settings, ThemeName } from "../../lib/ipc";
import { DEFAULT_THEME_ID, themeById, type ThemeDef } from "./catalogue";

export type ResolvedTheme = "dark" | "light";

export function resolveTheme(setting: ThemeName, prefersDark: boolean): ResolvedTheme {
  if (setting === "system") return prefersDark ? "dark" : "light";
  return setting;
}

/** The catalogue theme for the current mode; the variant's own kind wins over the mode. */
export function resolveAppTheme(settings: Pick<Settings, "theme"> & { appearance?: Partial<Settings["appearance"]> }, prefersDark: boolean): ThemeDef {
  const mode = resolveTheme(settings.theme, prefersDark);
  const chosen = themeById(mode === "dark" ? settings.appearance?.darkTheme : settings.appearance?.lightTheme);
  if (chosen && !chosen.terminalOnly) return chosen;
  return themeById(DEFAULT_THEME_ID[mode])!;
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
  } catch {
    return true;
  }
}

export const useResolvedTheme = create<{ theme: ResolvedTheme; id: string }>(() => ({ theme: "dark", id: DEFAULT_THEME_ID.dark }));
