/**
 * Terminal colour scheme resolution (D-057): `terminal.colorScheme` is "app" (follow the app
 * theme – default), a catalogue id (any theme, incl. terminal-only Campbell) or
 * "imported:<name>" (a scheme copied from Windows Terminal into `terminal.importedSchemes`).
 * Anything unknown follows the app theme.
 */
import type { TerminalScheme } from "../../lib/ipc";
import { DEFAULT_THEME_ID, themeById, type TerminalColors } from "./catalogue";
import { terminalColorsOf } from "./derive";
import { isHex, rgba } from "./color";

export const APP_SCHEME = "app";
export const IMPORTED_PREFIX = "imported:";

export function importedSchemeId(name: string): string {
  return `${IMPORTED_PREFIX}${name}`;
}

export function schemeToColors(s: TerminalScheme): TerminalColors {
  return {
    background: s.background,
    foreground: s.foreground,
    cursor: s.cursor,
    // Windows Terminal blends its selection colour over the text; xterm paints it opaque unless
    // it carries alpha, so imported selections get the same translucency as Kotilo's own.
    selection: isHex(s.selection) ? rgba(s.selection, 0.3) : s.selection,
    selectionInactive: isHex(s.selection) ? rgba(s.selection, 0.18) : undefined,
    ansi: {
      black: s.black,
      red: s.red,
      green: s.green,
      yellow: s.yellow,
      blue: s.blue,
      magenta: s.magenta,
      cyan: s.cyan,
      white: s.white,
      brightBlack: s.brightBlack,
      brightRed: s.brightRed,
      brightGreen: s.brightGreen,
      brightYellow: s.brightYellow,
      brightBlue: s.brightBlue,
      brightMagenta: s.brightMagenta,
      brightCyan: s.brightCyan,
      brightWhite: s.brightWhite,
    },
  };
}

export function resolveTerminalColors(colorScheme: string | undefined, imported: readonly TerminalScheme[] | undefined, appThemeId: string): TerminalColors {
  const app = () => terminalColorsOf(themeById(appThemeId) ?? themeById(DEFAULT_THEME_ID.dark)!);
  if (!colorScheme || colorScheme === APP_SCHEME) return app();
  if (colorScheme.startsWith(IMPORTED_PREFIX)) {
    const name = colorScheme.slice(IMPORTED_PREFIX.length);
    const scheme = imported?.find((s) => s.name === name);
    return scheme ? schemeToColors(scheme) : app();
  }
  const theme = themeById(colorScheme);
  return theme ? terminalColorsOf(theme) : app();
}
