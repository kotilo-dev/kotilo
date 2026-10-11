/**
 * Theme values for consumers that can't read CSS variables directly (xterm before it is
 * attached, Monaco's `defineTheme`, jsdom tests). `index.css` is the source of truth;
 * `palette.test.ts` fails if a value here drifts from it. Components never use these —
 * they use the CSS tokens.
 */
import type { ResolvedTheme } from "./resolvedTheme";

export interface ThemePalette {
  bg: string;
  surface2: string;
  terminalBg: string;
  text: string;
  accent: string;
  ansi: {
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
  terminalSelection: string;
  terminalSelectionInactive: string;
}

export const PALETTES: Record<ResolvedTheme, ThemePalette> = {
  dark: {
    bg: "#0b0c0f",
    surface2: "#111318",
    terminalBg: "#0e1014",
    text: "#e7e9ee",
    accent: "#7c9cff",
    ansi: {
      black: "#1b1e24",
      red: "#ff6b5a",
      green: "#46c58a",
      yellow: "#f2b440",
      blue: "#7c9cff",
      magenta: "#c792ea",
      cyan: "#5ccfe6",
      white: "#c9ccd4",
      brightBlack: "#4a4f5c",
      brightRed: "#ff9d90",
      brightGreen: "#7fd8a4",
      brightYellow: "#f6c86b",
      brightBlue: "#9fb4ff",
      brightMagenta: "#d29bf0",
      brightCyan: "#86c8f0",
      brightWhite: "#e7e9ee",
    },
    terminalSelection: "rgba(124, 156, 255, 0.25)",
    terminalSelectionInactive: "rgba(124, 156, 255, 0.14)",
  },
  light: {
    bg: "#eceef2",
    surface2: "#ffffff",
    terminalBg: "#fbfbfc",
    text: "#14161b",
    accent: "#3d5fd9",
    ansi: {
      black: "#383a42",
      red: "#d43b2a",
      green: "#1f8f5c",
      yellow: "#9a6500",
      blue: "#3d5fd9",
      magenta: "#a626a4",
      cyan: "#0b7f96",
      white: "#5b616d",
      brightBlack: "#6b7180",
      brightRed: "#b22a1c",
      brightGreen: "#166b45",
      brightYellow: "#7f5400",
      brightBlue: "#2a46b0",
      brightMagenta: "#84197f",
      brightCyan: "#086478",
      brightWhite: "#14161b",
    },
    terminalSelection: "rgba(61, 95, 217, 0.22)",
    terminalSelectionInactive: "rgba(61, 95, 217, 0.12)",
  },
};

/** CSS variable name for each ANSI key (`brightRed` → `--ansi-bright-red`). */
export function ansiVar(key: keyof ThemePalette["ansi"]): string {
  return `--ansi-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}
