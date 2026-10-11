import { afterEach, describe, expect, it, vi } from "vitest";
import { PALETTES } from "../../app/theme/palette";
import { resolveTerminalColors } from "../../app/theme/terminalScheme";

// `Channel`'ın gerçek implementasyonu `window.__TAURI_INTERNALS__` ister (jsdom'da yok) —
// `terminalStore.test.ts`'teki desenin aynısı: sahte, yalnızca `onmessage` taşıyan bir sınıf.
const ipc = vi.hoisted(() => ({
  Channel: class FakeChannel<T> {
    onmessage: ((data: T) => void) | undefined;
  },
}));

vi.mock("../../lib/ipc", () => ipc);

import {
  clearAllEntries,
  disposeTerminal,
  effectiveTerminalFont,
  getChannel,
  getOrCreateEntry,
  resetCreateTerminalFactory,
  setCreateTerminalFactory,
  setTerminalFontSuggestion,
  xtermThemeFor,
} from "./terminalRegistry";

interface FakeTerm {
  cols: number;
  rows: number;
  write: (data: string | Uint8Array, callback?: () => void) => void;
  dispose: () => void;
  reset: () => void;
}

function makeFakeTerm(): FakeTerm {
  return { cols: 80, rows: 24, write: vi.fn(), dispose: vi.fn(), reset: vi.fn() };
}

describe("disposeTerminal (LOW #6)", () => {
  it("neutralises the channel so a late batch cannot write into the disposed terminal", () => {
    setCreateTerminalFactory(() => makeFakeTerm());
    try {
      const tabId = "term-late-batch";
      const entry = getOrCreateEntry(tabId);
      const channel = getChannel(tabId);
      expect(channel.onmessage).toBeDefined();

      disposeTerminal(tabId);

      // Backend'den gecikmeli gelen bir batch (dispose'dan sonra, `pty_kill`in ack'i backend'e
      // henüz ulaşmamışken) hâlâ bu `Channel` nesnesi üzerinden `onmessage` çağırabilir —
      // artık yok olmuş `term`'e `write` çağırmamalı.
      expect(() => channel.onmessage?.(new ArrayBuffer(0))).not.toThrow();
      expect(entry.term.write as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    } finally {
      clearAllEntries();
      resetCreateTerminalFactory();
    }
  });

  it("still disposes the term and runs registered disposables", () => {
    setCreateTerminalFactory(() => makeFakeTerm());
    try {
      const tabId = "term-dispose";
      const entry = getOrCreateEntry(tabId);
      const disposable = vi.fn();
      entry.disposables.push(disposable);

      disposeTerminal(tabId);

      expect(entry.term.dispose as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
      expect(disposable).toHaveBeenCalledTimes(1);
    } finally {
      clearAllEntries();
      resetCreateTerminalFactory();
    }
  });
});

describe("xtermThemeFor (DESIGN_SYSTEM §8, D-057)", () => {
  const kotilo = (kind: "dark" | "light") => resolveTerminalColors("app", [], `kotilo-${kind}`);

  it("returns a distinct, full ANSI palette per theme", () => {
    const dark = xtermThemeFor(kotilo("dark"));
    const light = xtermThemeFor(kotilo("light"));
    expect(dark.red).toBeDefined();
    expect(light.red).toBeDefined();
    expect(dark.brightYellow).toBeDefined();
    expect(light.brightYellow).toBeDefined();
    expect(dark.red).not.toBe(light.red);
  });

  it("Kotilo themes use today's tokens (palette.ts mirrors index.css)", () => {
    const light = xtermThemeFor(kotilo("light"));
    expect(light.background).toBe(PALETTES.light.terminalBg);
    const dark = xtermThemeFor(kotilo("dark"));
    expect(dark.background).toBe(PALETTES.dark.terminalBg);
    expect(dark.foreground).toBe(PALETTES.dark.text);
    expect(dark.cursor).toBe(PALETTES.dark.accent);
    expect(dark.red).toBe(PALETTES.dark.ansi.red);
  });

  it("sets a visible, distinct selection background per theme (#9: light selection was invisible)", () => {
    const dark = xtermThemeFor(kotilo("dark"));
    const light = xtermThemeFor(kotilo("light"));
    expect(dark.selectionBackground).toBeDefined();
    expect(light.selectionBackground).toBeDefined();
    expect(dark.selectionBackground).not.toBe(light.selectionBackground);
    // Açık temada seçim rengi zeminle (#ffffff) aynı olmamalı — aksi halde görünmez kalır.
    expect(light.selectionBackground).not.toBe(light.background);
    expect(dark.selectionBackground).not.toBe(dark.background);
  });

  it("sets a distinct inactive selection background per theme", () => {
    const dark = xtermThemeFor(kotilo("dark"));
    const light = xtermThemeFor(kotilo("light"));
    expect(dark.selectionInactiveBackground).toBeDefined();
    expect(light.selectionInactiveBackground).toBeDefined();
    expect(dark.selectionInactiveBackground).not.toBe(dark.selectionBackground);
    expect(light.selectionInactiveBackground).not.toBe(light.selectionBackground);
  });

  it("sets cursorAccent to the scheme background so cursor text stays readable", () => {
    const theme = xtermThemeFor(resolveTerminalColors("campbell", [], "kotilo-dark"));
    expect(theme.background).toBe("#0c0c0c");
    expect(theme.cursorAccent).toBe("#0c0c0c");
  });
});

describe("effectiveTerminalFont (D-055)", () => {
  const DEFAULT = '"Geist Mono", "Cascadia Code", Consolas, monospace';
  afterEach(() => setTerminalFontSuggestion(null));

  it("puts a detected Nerd Font in front of the default font", () => {
    setTerminalFontSuggestion("MesloLGM Nerd Font");
    expect(effectiveTerminalFont(DEFAULT)).toBe(`"MesloLGM Nerd Font", ${DEFAULT}`);
    expect(effectiveTerminalFont("")).toBe(`"MesloLGM Nerd Font", ${DEFAULT}`);
  });

  it("keeps a font the user chose and the default when nothing was detected", () => {
    setTerminalFontSuggestion("MesloLGM Nerd Font");
    expect(effectiveTerminalFont("Consolas")).toBe("Consolas");
    setTerminalFontSuggestion(null);
    expect(effectiveTerminalFont(DEFAULT)).toBe(DEFAULT);
  });
});
