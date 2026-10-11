/**
 * The theme actually shown: the setting, with "system" resolved from the OS preference.
 * Everything that paints (tokens via `<html data-theme>`, Monaco, highlight.js, xterm)
 * reads this, never the raw setting.
 */
import { create } from "zustand";
import type { ThemeName } from "../../lib/ipc";

export type ResolvedTheme = "dark" | "light";

export function resolveTheme(setting: ThemeName, prefersDark: boolean): ResolvedTheme {
  if (setting === "system") return prefersDark ? "dark" : "light";
  return setting;
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
  } catch {
    return true;
  }
}

export const useResolvedTheme = create<{ theme: ResolvedTheme }>(() => ({ theme: "dark" }));
