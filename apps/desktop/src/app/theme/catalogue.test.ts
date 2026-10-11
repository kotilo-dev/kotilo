import { afterEach, describe, expect, it } from "vitest";
import { appThemes, groupByFamily, themeById, THEMES } from "./catalogue";
import { contrast, ensureContrast, isHex, mix, parseHex } from "./color";
import { THEME_TOKEN_NAMES, terminalColorsOf, themeTokens } from "./derive";
import { PALETTES } from "./palette";
import { applyAppTheme, applyAppearance } from "./applyTheme";
import { resolveAppTheme, useResolvedTheme } from "./resolvedTheme";
import { importedSchemeId, resolveTerminalColors, schemeToColors } from "./terminalScheme";
import type { TerminalScheme } from "../../lib/ipc";

const EXPECTED_IDS = [
  "kotilo-dark",
  "kotilo-light",
  "catppuccin-mocha",
  "catppuccin-macchiato",
  "catppuccin-frappe",
  "catppuccin-latte",
  "tokyo-night",
  "tokyo-night-storm",
  "tokyo-night-moon",
  "tokyo-night-day",
  "rose-pine",
  "rose-pine-moon",
  "rose-pine-dawn",
  "dracula",
  "nord",
  "one-dark",
  "one-light",
  "gruvbox-dark",
  "gruvbox-light",
  "solarized-dark",
  "solarized-light",
  "github-dark",
  "github-light",
  "kanagawa-wave",
  "kanagawa-dragon",
  "kanagawa-lotus",
  "everforest-dark",
  "everforest-light",
  "campbell",
];

/** Parses an opaque hex token; the test only checks opaque colours. */
function hex(value: string | undefined): string {
  expect(value && isHex(value), `expected #rrggbb, got ${value}`).toBe(true);
  return value!;
}

describe("theme catalogue (D-057)", () => {
  it("has every promised theme, unique kebab-case ids, names and families", () => {
    expect(THEMES.map((t) => t.id)).toEqual(EXPECTED_IDS);
    for (const t of THEMES) {
      expect(t.id).toMatch(/^[a-z0-9-]{1,64}$/);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.family.length).toBeGreaterThan(0);
    }
  });

  it("every colour is #rrggbb and every theme has 16 ANSI colours", () => {
    for (const t of THEMES) {
      const port = t.terminal;
      expect(Object.keys(port.ansi)).toHaveLength(16);
      const colours = [port.background, port.foreground, ...Object.values(port.ansi), ...(t.seed ? Object.values(t.seed) : [])];
      for (const c of colours) expect(isHex(c), `${t.id}: ${c}`).toBe(true);
    }
  });

  it("seed background is the port's terminal background (same project, same base)", () => {
    for (const t of THEMES.filter((t) => t.seed)) expect(t.seed!.bg, t.id).toBe(t.terminal.background);
  });

  it("app themes exclude terminal-only Campbell and group by family in catalogue order", () => {
    expect(appThemes().some((t) => t.id === "campbell")).toBe(false);
    expect(appThemes("dark").every((t) => t.kind === "dark")).toBe(true);
    expect(appThemes("light").map((t) => t.id)).toContain("catppuccin-latte");
    expect(groupByFamily(appThemes("dark")).map(([family]) => family)[0]).toBe("Kotilo");
  });

  it("Kotilo themes have no derived tokens and carry today's terminal palette", () => {
    for (const kind of ["dark", "light"] as const) {
      const t = themeById(`kotilo-${kind}`)!;
      expect(themeTokens(t)).toBeNull();
      const colors = terminalColorsOf(t);
      expect(colors.background).toBe(PALETTES[kind].terminalBg);
      expect(colors.foreground).toBe(PALETTES[kind].text);
      expect(colors.cursor).toBe(PALETTES[kind].accent);
      expect(colors.selection).toBe(PALETTES[kind].terminalSelection);
      expect(colors.selectionInactive).toBe(PALETTES[kind].terminalSelectionInactive);
      expect(colors.ansi).toEqual(PALETTES[kind].ansi);
    }
  });
});

describe("token derivation + contrast (whole catalogue)", () => {
  const derived = THEMES.filter((t) => t.seed);

  it("sets every token name", () => {
    for (const t of derived) {
      const tokens = themeTokens(t)!;
      for (const name of THEME_TOKEN_NAMES) expect(tokens[name], `${t.id} ${name}`).toBeTruthy();
    }
  });

  it.each(derived.map((t) => [t.id, t] as const))("%s meets the contrast targets on bg and panels", (_id, t) => {
    const tk = themeTokens(t)!;
    for (const ground of [hex(tk["--bg"]), hex(tk["--surface-2"])]) {
      expect(contrast(hex(tk["--text"]), ground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex(tk["--text-2"]), ground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex(tk["--text-muted"]), ground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex(tk["--text-faint"]), ground)).toBeGreaterThanOrEqual(3);
      expect(contrast(hex(tk["--accent"]), ground)).toBeGreaterThanOrEqual(3);
      for (const s of ["working", "blocked", "done", "idle", "error"]) {
        expect(contrast(hex(tk[`--status-${s}` as keyof typeof tk]), ground), s).toBeGreaterThanOrEqual(3);
        expect(contrast(hex(tk[`--status-${s}-ink` as keyof typeof tk]), ground), `${s}-ink`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(hex(tk["--on-accent"]), hex(tk["--accent"]))).toBeGreaterThanOrEqual(3);
  });

  it("keeps the surface order of the Kotilo tokens (dark: panels lighter than the window; light: panel lightest)", () => {
    for (const t of derived) {
      const tk = themeTokens(t)!;
      const l = (v: string) => parseHex(hex(v)).reduce((a, b) => a + b, 0);
      if (t.kind === "dark") {
        expect(l(tk["--surface-2"]), t.id).toBeGreaterThan(l(tk["--bg"]));
        expect(l(tk["--surface-5"]), t.id).toBeGreaterThan(l(tk["--surface-2"]));
      } else {
        expect(l(tk["--surface-2"]), t.id).toBeGreaterThan(l(tk["--bg"]));
        expect(l(tk["--surface-5"]), t.id).toBeLessThan(l(tk["--surface-2"]));
      }
    }
  });

  it("terminal tokens are the port's colours, untouched", () => {
    const mocha = themeTokens(themeById("catppuccin-mocha")!)!;
    expect(mocha["--terminal-bg"]).toBe("#1e1e2e");
    expect(mocha["--ansi-red"]).toBe("#f38ba8");
    expect(mocha["--terminal-selection"]).toBe("#585b70");
  });

  it("nudges a colour that misses its target and keeps one that meets it", () => {
    expect(ensureContrast("#ffffff", "#000000", 4.5, "#ffffff")).toBe("#ffffff");
    const nudged = ensureContrast("#31748f", "#13111b", 4.5, "#ffffff");
    expect(nudged).not.toBe("#31748f");
    expect(contrast(nudged, "#13111b")).toBeGreaterThanOrEqual(4.5);
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
});

describe("app theme resolution and application", () => {
  afterEach(() => {
    applyAppTheme(themeById("kotilo-dark")!);
    useResolvedTheme.setState({ theme: "dark", id: "kotilo-dark" });
  });

  const settings = (theme: "dark" | "light" | "system", darkTheme = "catppuccin-mocha", lightTheme = "catppuccin-latte") => ({
    theme,
    appearance: { darkTheme, lightTheme },
  });

  it("mode picks the dark or light theme; system follows the OS", () => {
    expect(resolveAppTheme(settings("dark"), false).id).toBe("catppuccin-mocha");
    expect(resolveAppTheme(settings("light"), true).id).toBe("catppuccin-latte");
    expect(resolveAppTheme(settings("system"), true).id).toBe("catppuccin-mocha");
    expect(resolveAppTheme(settings("system"), false).id).toBe("catppuccin-latte");
  });

  it("unknown, terminal-only or missing ids fall back to Kotilo", () => {
    expect(resolveAppTheme(settings("dark", "nope"), true).id).toBe("kotilo-dark");
    expect(resolveAppTheme(settings("dark", "campbell"), true).id).toBe("kotilo-dark");
    expect(resolveAppTheme({ theme: "light" }, true).id).toBe("kotilo-light");
  });

  it("sets the derived variables + data-theme, and Kotilo clears them again", () => {
    const root = document.documentElement;
    const theme = applyAppearance(settings("dark"), true, root);
    expect(theme.id).toBe("catppuccin-mocha");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.getPropertyValue("--terminal-bg")).toBe("#1e1e2e");
    expect(useResolvedTheme.getState()).toMatchObject({ theme: "dark", id: "catppuccin-mocha" });

    applyAppearance(settings("light"), true, root);
    expect(root.dataset.theme).toBe("light");

    applyAppearance(settings("dark", "kotilo-dark"), true, root);
    for (const name of THEME_TOKEN_NAMES) expect(root.style.getPropertyValue(name), name).toBe("");
    expect(root.dataset.theme).toBe("dark");
  });
});

describe("terminal scheme resolution", () => {
  const imported: TerminalScheme = {
    name: "One Half Dark",
    background: "#282c34",
    foreground: "#dcdfe4",
    cursor: "#ffffff",
    selection: "#ffffff",
    black: "#282c34",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#dcdfe4",
    brightBlack: "#5a6374",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#dcdfe4",
  };

  it("'app' follows the app theme", () => {
    expect(resolveTerminalColors("app", [], "gruvbox-dark").background).toBe("#282828");
    expect(resolveTerminalColors("app", [], "kotilo-light").background).toBe(PALETTES.light.terminalBg);
  });

  it("a catalogue id (incl. Campbell) wins over the app theme", () => {
    const campbell = resolveTerminalColors("campbell", [], "catppuccin-latte");
    expect(campbell.background).toBe("#0c0c0c");
    expect(campbell.ansi.blue).toBe("#0037da");
    expect(resolveTerminalColors("dracula", [], "kotilo-dark").foreground).toBe("#f8f8f2");
  });

  it("imported schemes map every colour; selection gets translucency", () => {
    const colors = resolveTerminalColors(importedSchemeId("One Half Dark"), [imported], "kotilo-dark");
    expect(colors).toEqual(schemeToColors(imported));
    expect(colors.background).toBe("#282c34");
    expect(colors.ansi.magenta).toBe("#c678dd");
    expect(colors.ansi.brightBlack).toBe("#5a6374");
    expect(colors.selection).toBe("rgba(255, 255, 255, 0.3)");
  });

  it("a missing import or unknown id falls back to the app theme", () => {
    expect(resolveTerminalColors(importedSchemeId("Gone"), [imported], "nord").background).toBe("#2e3440");
    expect(resolveTerminalColors("nope", undefined, "nord").background).toBe("#2e3440");
    expect(resolveTerminalColors(undefined, undefined, "nope").background).toBe(PALETTES.dark.terminalBg);
  });
});
