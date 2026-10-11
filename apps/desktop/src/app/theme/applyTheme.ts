/**
 * Puts an app theme on `<html>` (D-057): `data-theme` = the variant's kind (dark/light, picks the
 * `index.css` block and `color-scheme`), derived themes set their tokens as inline CSS variables
 * (which win over both `index.css` blocks), Kotilo themes clear them so `index.css` applies as is.
 */
import type { Settings } from "../../lib/ipc";
import type { ThemeDef } from "./catalogue";
import { THEME_TOKEN_NAMES, themeTokensById } from "./derive";
import { resolveAppTheme, useResolvedTheme } from "./resolvedTheme";

export function applyAppTheme(theme: ThemeDef, root: HTMLElement = document.documentElement): void {
  const tokens = themeTokensById(theme.id);
  for (const name of THEME_TOKEN_NAMES) {
    if (tokens) root.style.setProperty(name, tokens[name]);
    else root.style.removeProperty(name);
  }
  root.dataset.theme = theme.kind;
  root.dataset.colorTheme = theme.id;
}

/** Resolves the theme from the settings, applies it and publishes it in `useResolvedTheme`. */
export function applyAppearance(
  settings: Pick<Settings, "theme"> & { appearance?: Partial<Settings["appearance"]> },
  prefersDark: boolean,
  root: HTMLElement = document.documentElement,
): ThemeDef {
  const theme = resolveAppTheme(settings, prefersDark);
  applyAppTheme(theme, root);
  const current = useResolvedTheme.getState();
  if (current.theme !== theme.kind || current.id !== theme.id) useResolvedTheme.setState({ theme: theme.kind, id: theme.id });
  return theme;
}
