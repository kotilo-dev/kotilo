/**
 * UI tokens from a theme seed (D-057). A catalogue theme only names its background, text,
 * accent, four status hues and terminal colours; everything `index.css` defines for the app
 * chrome is derived here with the same structure as the Kotilo tokens:
 *
 * - dark: the window background is the theme background a quarter darker; surfaces 1–5 step
 *   from it toward the text colour (panels lighter than the window, like Kotilo Dark);
 * - light: the theme background is the panel colour (surface-2); the window and controls are
 *   slightly darker steps toward the text colour (like Kotilo Light);
 * - text steps mix the text toward the background; accent and status colours are the theme's
 *   own, and every colour that carries meaning is nudged (lighter on dark, darker on light)
 *   until it reaches its contrast target on the window background and on panels:
 *   text ≥ 4.5:1, muted text ≥ 4.5:1, faint text ≥ 3:1, accent/status ≥ 3:1, status ink ≥ 4.5:1.
 *
 * Agent identity, mascot and `--paper` tokens are never touched. Kotilo Dark/Light have no seed:
 * their tokens are `index.css` itself, so applying them clears every override.
 */
import { contrast, ensureContrast, mix, rgba } from "./color";
import { ansiVar } from "./palette";
import { themeById, type Ansi16, type TerminalColors, type ThemeDef, type ThemeKind, type ThemeSeed } from "./catalogue";

/** Every CSS variable a derived theme sets (and a Kotilo theme clears). */
export const THEME_TOKEN_NAMES = [
  "--bg",
  "--surface-1",
  "--surface-2",
  "--surface-3",
  "--surface-4",
  "--surface-5",
  "--surface-selected",
  "--track",
  "--terminal-bg",
  "--border",
  "--border-strong",
  "--text",
  "--text-2",
  "--text-3",
  "--text-muted",
  "--text-faint",
  "--accent",
  "--accent-soft",
  "--on-accent",
  ...(["working", "blocked", "done", "idle", "error"] as const).flatMap((s) => [`--status-${s}`, `--status-${s}-ink`, `--status-${s}-bg`]),
  ...(
    ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as Array<keyof Ansi16>
  ).map(ansiVar),
  "--terminal-selection",
  "--terminal-selection-inactive",
  "--elev-float",
  "--halo-working",
  "--halo-blocked",
  "--scrim",
  "--checkerboard-a",
  "--checkerboard-b",
] as const;

export type ThemeTokens = Record<(typeof THEME_TOKEN_NAMES)[number], string>;

const WHITE = "#ffffff";
const BLACK = "#000000";

/** Nudges `color` until it reaches `min` against every background in `on`. */
function readable(color: string, on: string[], min: number, toward: string): string {
  let result = color;
  for (let pass = 0; pass < 4; pass++) {
    const worst = on.reduce((acc, bg) => (contrast(result, bg) < contrast(result, acc) ? bg : acc), on[0]!);
    if (contrast(result, worst) >= min) return result;
    result = ensureContrast(result, worst, min, toward);
  }
  return result;
}

/** Selection tint for the terminal when the port has none (Kotilo style: accent at 25 %/22 %). */
function derivedSelection(accent: string, kind: ThemeKind): { selection: string; selectionInactive: string } {
  return kind === "dark"
    ? { selection: rgba(accent, 0.25), selectionInactive: rgba(accent, 0.14) }
    : { selection: rgba(accent, 0.22), selectionInactive: rgba(accent, 0.12) };
}

export function deriveTokens(seed: ThemeSeed, kind: ThemeKind, terminal: TerminalColors): ThemeTokens {
  const dark = kind === "dark";
  const toward = dark ? WHITE : BLACK;
  const base = seed.bg;
  const fg = seed.fg;

  const bg = dark ? mix(base, BLACK, 0.25) : mix(base, fg, 0.07);
  const step = (amount: number) => (dark ? mix(bg, fg, amount) : mix(base, fg, amount));
  const surface = dark
    ? { s1: step(0.018), s2: step(0.03), s3: step(0.045), s4: step(0.065), s5: step(0.08), selected: step(0.13), track: step(0.115) }
    : { s1: step(0.035), s2: base, s3: step(0.015), s4: step(0.06), s5: step(0.09), selected: step(0.12), track: step(0.13) };
  // Text sits on the window, on panels and on raised controls.
  const grounds = [bg, surface.s2, surface.s4];

  const text = readable(fg, grounds, 4.5, toward);
  const accent = readable(seed.accent, grounds, 3, toward);
  const plain = dark ? bg : WHITE;
  const onAccent = contrast(accent, plain) >= contrast(accent, text) ? plain : text;

  const status = (hue: string) => {
    const color = readable(hue, grounds, 3, toward);
    const tint = dark ? 0.14 : 0.1;
    const ink = readable(mix(color, toward, dark ? 0.3 : 0.25), [...grounds, mix(surface.s2, color, tint)], 4.5, toward);
    return { color, ink, bg: rgba(color, tint) };
  };
  const working = status(seed.yellow);
  const blocked = status(seed.red);
  const done = status(seed.blue);
  const idle = status(seed.green);

  const tokens: Partial<ThemeTokens> = {
    "--bg": bg,
    "--surface-1": surface.s1,
    "--surface-2": surface.s2,
    "--surface-3": surface.s3,
    "--surface-4": surface.s4,
    "--surface-5": surface.s5,
    "--surface-selected": surface.selected,
    "--track": surface.track,
    "--terminal-bg": terminal.background,
    "--border": rgba(fg, dark ? 0.07 : 0.1),
    "--border-strong": rgba(fg, dark ? 0.1 : 0.17),
    "--text": text,
    "--text-2": readable(mix(text, bg, 0.12), grounds, 4.5, toward),
    "--text-3": readable(mix(text, bg, 0.25), grounds, 4.5, toward),
    "--text-muted": readable(mix(text, bg, 0.42), grounds, 4.5, toward),
    "--text-faint": readable(mix(text, bg, 0.5), grounds, 3, toward),
    "--accent": accent,
    "--accent-soft": rgba(accent, dark ? 0.14 : 0.12),
    "--on-accent": onAccent,
    "--terminal-selection": terminal.selection,
    "--terminal-selection-inactive": terminal.selectionInactive ?? terminal.selection,
    "--elev-float": `0 18px 50px ${dark ? rgba(BLACK, 0.55) : rgba(fg, 0.18)}`,
    "--halo-working": `0 0 0 4px ${rgba(working.color, dark ? 0.05 : 0.08)}`,
    "--halo-blocked": `0 0 0 4px ${rgba(blocked.color, dark ? 0.08 : 0.1)}, 0 0 40px ${rgba(blocked.color, dark ? 0.1 : 0.08)}`,
    "--scrim": dark ? rgba(BLACK, 0.5) : rgba(fg, 0.3),
    "--checkerboard-a": dark ? mix(bg, fg, 0.13) : mix(base, fg, 0.12),
    "--checkerboard-b": dark ? mix(bg, fg, 0.09) : mix(base, fg, 0.2),
  };
  for (const [name, s] of [
    ["working", working],
    ["blocked", blocked],
    ["done", done],
    ["idle", idle],
    ["error", blocked],
  ] as const) {
    tokens[`--status-${name}`] = s.color;
    tokens[`--status-${name}-ink`] = s.ink;
    tokens[`--status-${name}-bg`] = s.bg;
  }
  for (const [key, value] of Object.entries(terminal.ansi) as Array<[keyof Ansi16, string]>) {
    tokens[ansiVar(key) as keyof ThemeTokens] = value;
  }
  return tokens as ThemeTokens;
}

/** The terminal colours a theme brings (port values; cursor/selection from the accent if missing). */
export function terminalColorsOf(theme: ThemeDef): TerminalColors {
  const port = theme.terminal;
  const accent = theme.seed?.accent ?? port.cursor ?? port.foreground;
  const derived = derivedSelection(accent, theme.kind);
  return {
    background: port.background,
    foreground: port.foreground,
    cursor: port.cursor ?? accent,
    selection: port.selection ?? derived.selection,
    selectionInactive: port.selection ? port.selectionInactive : derived.selectionInactive,
    ansi: port.ansi,
  };
}

/** Tokens to set for a theme, or `null` for Kotilo (clear every override, `index.css` applies). */
export function themeTokens(theme: ThemeDef): ThemeTokens | null {
  if (!theme.seed) return null;
  return deriveTokens(theme.seed, theme.kind, terminalColorsOf(theme));
}

const cache = new Map<string, ThemeTokens | null>();

export function themeTokensById(id: string): ThemeTokens | null {
  if (!cache.has(id)) {
    const theme = themeById(id);
    cache.set(id, theme ? themeTokens(theme) : null);
  }
  return cache.get(id) ?? null;
}
