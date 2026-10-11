/**
 * Built-in colour themes (D-057). Every value is copied from the project's own repository –
 * the terminal colours from its Windows Terminal / Alacritty / terminal port where one exists,
 * the UI seed (status and accent colours) from its palette. Sources and licences:
 * THIRD_PARTY_NOTICES ("Colour themes"). Kotilo Dark/Light are today's design tokens
 * (`index.css`, mirrored in `palette.ts`); the other themes derive their UI tokens from the
 * seed in `derive.ts`. Raw hex is fine here (catalogue data, like `index.css`).
 */
import { PALETTES, type ThemePalette } from "./palette";

export type ThemeKind = "dark" | "light";
export type Ansi16 = ThemePalette["ansi"];

/** What xterm needs (background, foreground, cursor, selection, 16 ANSI colours). */
export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  selectionInactive?: string;
  ansi: Ansi16;
}

/** UI seed: base background/text of the theme plus its accent and the four status hues. */
export interface ThemeSeed {
  bg: string;
  fg: string;
  accent: string;
  red: string;
  yellow: string;
  green: string;
  blue: string;
}

/** Terminal colours as given by the port; cursor/selection fall back to accent-based values. */
export interface TerminalPort {
  background: string;
  foreground: string;
  cursor?: string;
  selection?: string;
  selectionInactive?: string;
  ansi: Ansi16;
}

export interface ThemeDef {
  id: string;
  name: string;
  family: string;
  kind: ThemeKind;
  /** Offered only as a terminal scheme (Campbell), never as an app theme. */
  terminalOnly?: boolean;
  /** Absent for Kotilo Dark/Light (their tokens are `index.css` itself). */
  seed?: ThemeSeed;
  terminal: TerminalPort;
}

/** 16 colours in the usual order: black, red, green, yellow, blue, magenta, cyan, white, then the bright ones. */
function ansi(colors: string): Ansi16 {
  const c = colors.trim().split(/\s+/).map((v) => `#${v.toLowerCase()}`);
  if (c.length !== 16) throw new Error(`ansi(): expected 16 colours, got ${c.length}`);
  const [black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] =
    c as [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string];
  return { black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite };
}

function kotilo(kind: ThemeKind): TerminalPort {
  const p = PALETTES[kind];
  return { background: p.terminalBg, foreground: p.text, cursor: p.accent, selection: p.terminalSelection, selectionInactive: p.terminalSelectionInactive, ansi: p.ansi };
}

export const DEFAULT_THEME_ID: Record<ThemeKind, string> = { dark: "kotilo-dark", light: "kotilo-light" };

export const THEMES: readonly ThemeDef[] = [
  { id: "kotilo-dark", name: "Kotilo Dark", family: "Kotilo", kind: "dark", terminal: kotilo("dark") },
  { id: "kotilo-light", name: "Kotilo Light", family: "Kotilo", kind: "light", terminal: kotilo("light") },

  // Catppuccin – catppuccin/palette (UI), catppuccin/windows-terminal (terminal). Accent: mauve.
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    family: "Catppuccin",
    kind: "dark",
    seed: { bg: "#1e1e2e", fg: "#cdd6f4", accent: "#cba6f7", red: "#f38ba8", yellow: "#f9e2af", green: "#a6e3a1", blue: "#89b4fa" },
    terminal: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selection: "#585b70",
      ansi: ansi("45475A F38BA8 A6E3A1 F9E2AF 89B4FA F5C2E7 94E2D5 BAC2DE 585B70 F38BA8 A6E3A1 F9E2AF 89B4FA F5C2E7 94E2D5 A6ADC8"),
    },
  },
  {
    id: "catppuccin-macchiato",
    name: "Catppuccin Macchiato",
    family: "Catppuccin",
    kind: "dark",
    seed: { bg: "#24273a", fg: "#cad3f5", accent: "#c6a0f6", red: "#ed8796", yellow: "#eed49f", green: "#a6da95", blue: "#8aadf4" },
    terminal: {
      background: "#24273a",
      foreground: "#cad3f5",
      cursor: "#f4dbd6",
      selection: "#5b6078",
      ansi: ansi("494D64 ED8796 A6DA95 EED49F 8AADF4 F5BDE6 8BD5CA B8C0E0 5B6078 ED8796 A6DA95 EED49F 8AADF4 F5BDE6 8BD5CA A5ADCB"),
    },
  },
  {
    id: "catppuccin-frappe",
    name: "Catppuccin Frappé",
    family: "Catppuccin",
    kind: "dark",
    seed: { bg: "#303446", fg: "#c6d0f5", accent: "#ca9ee6", red: "#e78284", yellow: "#e5c890", green: "#a6d189", blue: "#8caaee" },
    terminal: {
      background: "#303446",
      foreground: "#c6d0f5",
      cursor: "#f2d5cf",
      selection: "#626880",
      ansi: ansi("51576D E78284 A6D189 E5C890 8CAAEE F4B8E4 81C8BE B5BFE2 626880 E78284 A6D189 E5C890 8CAAEE F4B8E4 81C8BE A5ADCE"),
    },
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    family: "Catppuccin",
    kind: "light",
    seed: { bg: "#eff1f5", fg: "#4c4f69", accent: "#8839ef", red: "#d20f39", yellow: "#df8e1d", green: "#40a02b", blue: "#1e66f5" },
    terminal: {
      background: "#eff1f5",
      foreground: "#4c4f69",
      cursor: "#dc8a78",
      selection: "#acb0be",
      ansi: ansi("5C5F77 D20F39 40A02B DF8E1D 1E66F5 EA76CB 179299 ACB0BE ACB0BE D20F39 40A02B DF8E1D 1E66F5 EA76CB 179299 BCC0CC"),
    },
  },

  // Tokyo Night – folke/tokyonight.nvim extras/windows_terminal.
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    family: "Tokyo Night",
    kind: "dark",
    seed: { bg: "#1a1b26", fg: "#c0caf5", accent: "#7aa2f7", red: "#f7768e", yellow: "#e0af68", green: "#9ece6a", blue: "#7aa2f7" },
    terminal: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      selection: "#283457",
      ansi: ansi("15161e f7768e 9ece6a e0af68 7aa2f7 bb9af7 7dcfff a9b1d6 414868 f7768e 9ece6a e0af68 7aa2f7 9d7cd8 7dcfff c0caf5"),
    },
  },
  {
    id: "tokyo-night-storm",
    name: "Tokyo Night Storm",
    family: "Tokyo Night",
    kind: "dark",
    seed: { bg: "#24283b", fg: "#c0caf5", accent: "#7aa2f7", red: "#f7768e", yellow: "#e0af68", green: "#9ece6a", blue: "#7aa2f7" },
    terminal: {
      background: "#24283b",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      selection: "#2e3c64",
      ansi: ansi("1d202f f7768e 9ece6a e0af68 7aa2f7 bb9af7 7dcfff a9b1d6 414868 f7768e 9ece6a e0af68 7aa2f7 9d7cd8 7dcfff c0caf5"),
    },
  },
  {
    id: "tokyo-night-moon",
    name: "Tokyo Night Moon",
    family: "Tokyo Night",
    kind: "dark",
    seed: { bg: "#222436", fg: "#c8d3f5", accent: "#82aaff", red: "#ff757f", yellow: "#ffc777", green: "#c3e88d", blue: "#82aaff" },
    terminal: {
      background: "#222436",
      foreground: "#c8d3f5",
      cursor: "#c8d3f5",
      selection: "#2d3f76",
      ansi: ansi("1b1d2b ff757f c3e88d ffc777 82aaff c099ff 86e1fc 828bb8 444a73 ff757f c3e88d ffc777 82aaff fca7ea 86e1fc c8d3f5"),
    },
  },
  {
    id: "tokyo-night-day",
    name: "Tokyo Night Day",
    family: "Tokyo Night",
    kind: "light",
    seed: { bg: "#e1e2e7", fg: "#3760bf", accent: "#2e7de9", red: "#f52a65", yellow: "#8c6c3e", green: "#587539", blue: "#2e7de9" },
    terminal: {
      background: "#e1e2e7",
      foreground: "#3760bf",
      cursor: "#3760bf",
      selection: "#b7c1e3",
      ansi: ansi("b4b5b9 f52a65 587539 8c6c3e 2e7de9 9854f1 007197 6172b0 a1a6c5 f52a65 587539 8c6c3e 2e7de9 7847bd 007197 3760bf"),
    },
  },

  // Rosé Pine – rose-pine/palette (UI: love, gold, pine, foam, iris), rose-pine/windows-terminal.
  {
    id: "rose-pine",
    name: "Rosé Pine",
    family: "Rosé Pine",
    kind: "dark",
    seed: { bg: "#191724", fg: "#e0def4", accent: "#c4a7e7", red: "#eb6f92", yellow: "#f6c177", green: "#31748f", blue: "#9ccfd8" },
    terminal: {
      background: "#191724",
      foreground: "#e0def4",
      cursor: "#6e6a86",
      selection: "#403d52",
      ansi: ansi("26233a eb6f92 31748f f6c177 9ccfd8 c4a7e7 ebbcba e0def4 908caa eb6f92 31748f f6c177 9ccfd8 c4a7e7 ebbcba e0def4"),
    },
  },
  {
    id: "rose-pine-moon",
    name: "Rosé Pine Moon",
    family: "Rosé Pine",
    kind: "dark",
    seed: { bg: "#232136", fg: "#e0def4", accent: "#c4a7e7", red: "#eb6f92", yellow: "#f6c177", green: "#3e8fb0", blue: "#9ccfd8" },
    terminal: {
      background: "#232136",
      foreground: "#e0def4",
      cursor: "#6e6a86",
      selection: "#44415a",
      ansi: ansi("393552 eb6f92 3e8fb0 f6c177 9ccfd8 c4a7e7 ea9a97 e0def4 908caa eb6f92 3e8fb0 f6c177 9ccfd8 c4a7e7 ea9a97 e0def4"),
    },
  },
  {
    id: "rose-pine-dawn",
    name: "Rosé Pine Dawn",
    family: "Rosé Pine",
    kind: "light",
    seed: { bg: "#faf4ed", fg: "#575279", accent: "#907aa9", red: "#b4637a", yellow: "#ea9d34", green: "#286983", blue: "#56949f" },
    terminal: {
      background: "#faf4ed",
      foreground: "#575279",
      cursor: "#9893a5",
      selection: "#dfdad9",
      ansi: ansi("f2e9e1 b4637a 286983 ea9d34 56949f 907aa9 d7827e 575279 797593 b4637a 286983 ea9d34 56949f 907aa9 d7827e 575279"),
    },
  },

  // Dracula – dracula/windows-terminal (no blue in the spec: "done" uses cyan, accent purple).
  {
    id: "dracula",
    name: "Dracula",
    family: "Dracula",
    kind: "dark",
    seed: { bg: "#282a36", fg: "#f8f8f2", accent: "#bd93f9", red: "#ff5555", yellow: "#f1fa8c", green: "#50fa7b", blue: "#8be9fd" },
    terminal: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      selection: "#44475a",
      ansi: ansi("21222C FF5555 50FA7B F1FA8C BD93F9 FF79C6 8BE9FD F8F8F2 6272A4 FF6E6E 69FF94 FFFFA5 D6ACFF FF92DF A4FFFF FFFFFF"),
    },
  },

  // Nord – nordtheme/nord (selection nord2, accent nord8), nordtheme/xfce-terminal.
  {
    id: "nord",
    name: "Nord",
    family: "Nord",
    kind: "dark",
    seed: { bg: "#2e3440", fg: "#d8dee9", accent: "#88c0d0", red: "#bf616a", yellow: "#ebcb8b", green: "#a3be8c", blue: "#81a1c1" },
    terminal: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      selection: "#434c5e",
      ansi: ansi("3B4252 BF616A A3BE8C EBCB8B 81A1C1 B48EAD 88C0D0 E5E9F0 4C566A BF616A A3BE8C EBCB8B 81A1C1 B48EAD 8FBCBB ECEFF4"),
    },
  },

  // One Dark – joshdick/onedark.vim terminal port (Atom One Dark). One Light – Atom
  // one-light-syntax (UI) + Windows Terminal's "One Half Light" (sonph/onehalf) for the terminal.
  {
    id: "one-dark",
    name: "One Dark",
    family: "One",
    kind: "dark",
    seed: { bg: "#282c34", fg: "#abb2bf", accent: "#61afef", red: "#e06c75", yellow: "#e5c07b", green: "#98c379", blue: "#61afef" },
    terminal: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#5c6370",
      selection: "#3e4452",
      ansi: ansi("2c323c e06c75 98c379 e5c07b 61afef c678dd 56b6c2 5c6370 3e4452 e06c75 98c379 e5c07b 61afef c678dd 56b6c2 abb2bf"),
    },
  },
  {
    id: "one-light",
    name: "One Light",
    family: "One",
    kind: "light",
    seed: { bg: "#fafafa", fg: "#383a42", accent: "#4078f2", red: "#e45649", yellow: "#c18301", green: "#50a14f", blue: "#4078f2" },
    terminal: {
      background: "#fafafa",
      foreground: "#383a42",
      cursor: "#4f525d",
      ansi: ansi("383A42 E45649 50A14F C18301 0184BC A626A4 0997B3 FAFAFA 4F525D DF6C75 98C379 E4C07A 61AFEF C577DD 56B5C1 FFFFFF"),
    },
  },

  // Gruvbox – morhetz/gruvbox (bright colours on dark, faded on light), morhetz/gruvbox-contrib (xfce4-terminal).
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    family: "Gruvbox",
    kind: "dark",
    seed: { bg: "#282828", fg: "#ebdbb2", accent: "#83a598", red: "#fb4934", yellow: "#fabd2f", green: "#b8bb26", blue: "#83a598" },
    terminal: {
      background: "#282828",
      foreground: "#ebdbb2",
      ansi: ansi("282828 cc241d 98971a d79921 458588 b16286 689d6a a89984 928374 fb4934 b8bb26 fabd2f 83a598 d3869b 8ec07c ebdbb2"),
    },
  },
  {
    id: "gruvbox-light",
    name: "Gruvbox Light",
    family: "Gruvbox",
    kind: "light",
    seed: { bg: "#fbf1c7", fg: "#3c3836", accent: "#076678", red: "#9d0006", yellow: "#b57614", green: "#79740e", blue: "#076678" },
    terminal: {
      background: "#fbf1c7",
      foreground: "#3c3836",
      ansi: ansi("fdf4c1 cc241d 98971a d79921 458588 b16286 689d6a 7c6f64 928374 9d0006 79740e b57614 076678 8f3f71 427b58 3c3836"),
    },
  },

  // Solarized – altercation/solarized palette; terminal as in Windows Terminal's built-in schemes.
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    family: "Solarized",
    kind: "dark",
    seed: { bg: "#002b36", fg: "#839496", accent: "#268bd2", red: "#dc322f", yellow: "#b58900", green: "#859900", blue: "#268bd2" },
    terminal: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#ffffff",
      ansi: ansi("002B36 DC322F 859900 B58900 268BD2 D33682 2AA198 EEE8D5 073642 CB4B16 586E75 657B83 839496 6C71C4 93A1A1 FDF6E3"),
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    family: "Solarized",
    kind: "light",
    seed: { bg: "#fdf6e3", fg: "#657b83", accent: "#268bd2", red: "#dc322f", yellow: "#b58900", green: "#859900", blue: "#268bd2" },
    terminal: {
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#002b36",
      ansi: ansi("002B36 DC322F 859900 B58900 268BD2 D33682 2AA198 EEE8D5 073642 CB4B16 586E75 657B83 839496 6C71C4 93A1A1 FDF6E3"),
    },
  },

  // GitHub – primer/github-vscode-theme (Dark/Light Default, incl. its overrides) on @primer/primitives 7.10.0.
  {
    id: "github-dark",
    name: "GitHub Dark",
    family: "GitHub",
    kind: "dark",
    seed: { bg: "#0d1117", fg: "#e6edf3", accent: "#2f81f7", red: "#f85149", yellow: "#d29922", green: "#3fb950", blue: "#58a6ff" },
    terminal: {
      background: "#0d1117",
      foreground: "#e6edf3",
      ansi: ansi("484f58 ff7b72 3fb950 d29922 58a6ff bc8cff 39c5cf b1bac4 6e7681 ffa198 56d364 e3b341 79c0ff d2a8ff 56d4dd ffffff"),
    },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    family: "GitHub",
    kind: "light",
    seed: { bg: "#ffffff", fg: "#1f2328", accent: "#0969da", red: "#cf222e", yellow: "#9a6700", green: "#1a7f37", blue: "#0969da" },
    terminal: {
      background: "#ffffff",
      foreground: "#1f2328",
      ansi: ansi("24292f cf222e 116329 4d2d00 0969da 8250df 1b7c83 6e7781 57606a a40e26 1a7f37 633c01 218bff a475f9 3192aa 8c959f"),
    },
  },

  // Kanagawa – rebelot/kanagawa.nvim (lua/kanagawa/colors.lua, extras/alacritty).
  {
    id: "kanagawa-wave",
    name: "Kanagawa Wave",
    family: "Kanagawa",
    kind: "dark",
    seed: { bg: "#1f1f28", fg: "#dcd7ba", accent: "#957fb8", red: "#e82424", yellow: "#e6c384", green: "#98bb6c", blue: "#7e9cd8" },
    terminal: {
      background: "#1f1f28",
      foreground: "#dcd7ba",
      selection: "#2d4f67",
      ansi: ansi("090618 c34043 76946a c0a36e 7e9cd8 957fb8 6a9589 c8c093 727169 e82424 98bb6c e6c384 7fb4ca 938aa9 7aa89f dcd7ba"),
    },
  },
  {
    id: "kanagawa-dragon",
    name: "Kanagawa Dragon",
    family: "Kanagawa",
    kind: "dark",
    seed: { bg: "#181616", fg: "#c5c9c5", accent: "#8992a7", red: "#e46876", yellow: "#c4b28a", green: "#87a987", blue: "#8ba4b0" },
    terminal: {
      background: "#181616",
      foreground: "#c5c9c5",
      selection: "#2d4f67",
      ansi: ansi("0d0c0c c4746e 8a9a7b c4b28a 8ba4b0 a292a3 8ea4a2 c8c093 a6a69c e46876 87a987 e6c384 7fb4ca 938aa9 7aa89f c5c9c5"),
    },
  },
  {
    id: "kanagawa-lotus",
    name: "Kanagawa Lotus",
    family: "Kanagawa",
    kind: "light",
    seed: { bg: "#f2ecbc", fg: "#545464", accent: "#624c83", red: "#c84053", yellow: "#77713f", green: "#6f894e", blue: "#4d699b" },
    terminal: {
      background: "#f2ecbc",
      foreground: "#545464",
      selection: "#c9cbd1",
      ansi: ansi("1f1f28 c84053 6f894e 77713f 4d699b b35b79 597b75 545464 8a8980 d7474b 6e915f 836f4a 6693bf 624c83 5e857a 43436c"),
    },
  },

  // Everforest (medium) – sainnhe/everforest autoload palette; terminal colours as its colors/everforest.vim sets them.
  {
    id: "everforest-dark",
    name: "Everforest Dark",
    family: "Everforest",
    kind: "dark",
    seed: { bg: "#2d353b", fg: "#d3c6aa", accent: "#7fbbb3", red: "#e67e80", yellow: "#dbbc7f", green: "#a7c080", blue: "#7fbbb3" },
    terminal: {
      background: "#2d353b",
      foreground: "#d3c6aa",
      selection: "#543a48",
      ansi: ansi("475258 e67e80 a7c080 dbbc7f 7fbbb3 d699b6 83c092 d3c6aa 475258 e67e80 a7c080 dbbc7f 7fbbb3 d699b6 83c092 d3c6aa"),
    },
  },
  {
    id: "everforest-light",
    name: "Everforest Light",
    family: "Everforest",
    kind: "light",
    seed: { bg: "#fdf6e3", fg: "#5c6a72", accent: "#3a94c5", red: "#f85552", yellow: "#dfa000", green: "#8da101", blue: "#3a94c5" },
    terminal: {
      background: "#fdf6e3",
      foreground: "#5c6a72",
      selection: "#eaedc8",
      ansi: ansi("5c6a72 f85552 8da101 dfa000 3a94c5 df69ba 35a77c e6e2cc 5c6a72 f85552 8da101 dfa000 3a94c5 df69ba 35a77c e6e2cc"),
    },
  },

  // Campbell – Windows Terminal's default scheme (microsoft/terminal defaults.json). Terminal only.
  {
    id: "campbell",
    name: "Campbell",
    family: "Windows Terminal",
    kind: "dark",
    terminalOnly: true,
    terminal: {
      background: "#0c0c0c",
      foreground: "#cccccc",
      cursor: "#ffffff",
      ansi: ansi("0C0C0C C50F1F 13A10E C19C00 0037DA 881798 3A96DD CCCCCC 767676 E74856 16C60C F9F1A5 3B78FF B4009E 61D6D6 F2F2F2"),
    },
  },
];

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

export function themeById(id: string | undefined | null): ThemeDef | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Themes offered as app themes (no terminal-only ones), optionally of one kind. */
export function appThemes(kind?: ThemeKind): ThemeDef[] {
  return THEMES.filter((t) => !t.terminalOnly && (kind === undefined || t.kind === kind));
}

/** `[family, themes]` in catalogue order – the pickers group by family. */
export function groupByFamily(themes: readonly ThemeDef[]): Array<[string, ThemeDef[]]> {
  const groups = new Map<string, ThemeDef[]>();
  for (const t of themes) groups.set(t.family, [...(groups.get(t.family) ?? []), t]);
  return Array.from(groups.entries());
}
