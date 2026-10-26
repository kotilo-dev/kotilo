/**
 * xterm örnekleri React dışında (faz4-spec §2.1). Modül düzeyinde `Map<tabId, TermEntry>` —
 * `host` bir kez oluşturulur, `term.open(host)` bir kez çağrılır (`TerminalView` bunu yönetir).
 * React bileşeni yalnızca `host`'u kendi kutusuna `appendChild` eder / unmount'ta ayırır:
 * **unmount terminali öldürmez** (StrictMode, panel collapse, workspace geçişi güvenli).
 * Terminal yalnızca sekme kapatılınca `disposeTerminal(tabId)` ile yok edilir.
 *
 * `createTerminal` fabrikası enjekte edilebilir (faz4-spec §4.22) — store testleri jsdom'da
 * gerçek xterm/WebGL yerine sahte bir terminal (`write/dispose/reset/cols/rows`) kullanır.
 */
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import type { WebglAddon } from "@xterm/addon-webgl";
import { Channel, clipboardWriteText } from "../../lib/ipc";
import { parseOsc52, RECENT_OUTPUT_ROWS, recentOutputText, RESET_MODES_SEQUENCE } from "./terminalExtras";
import { useResolvedTheme } from "../../app/theme/resolvedTheme";
import { useSettingsStore } from "../../stores/settingsStore";
import type { TerminalColors } from "../../app/theme/catalogue";
import { resolveTerminalColors } from "../../app/theme/terminalScheme";
import { isWindowTranslucent } from "../../app/theme/applyTheme";

/** Store + registry'nin ihtiyaç duyduğu asgari yüzey — gerçek `Terminal` bunu karşılar. */
export interface TermLike {
  cols: number;
  rows: number;
  write(data: Uint8Array | string, callback?: () => void): void;
  reset(): void;
  dispose(): void;
}

export interface TermEntry {
  tabId: string;
  term: TermLike;
  /** Bir kez oluşturulan DOM konteyneri; `TerminalView` bunu kendi kutusuna taşır. */
  host: HTMLDivElement;
  channel: Channel<ArrayBuffer> | null;
  paneId: string | null;
  /** `term.open(host)` çağrıldı mı (host DOM'a bağlı + boyutu > 0 olduğu ilk mount, §4.9). */
  opened: boolean;
  /** `TerminalView` tarafından açılışta bir kez yüklenir; burada saklanır ki fit/arama erişebilsin. */
  fit: { fit(): void } | null;
  search: { findNext(term: string): boolean; findPrevious(term: string): boolean } | null;
  webgl: WebglAddon | null;
  /** WebGL context losses so far; after a few the terminal stays on the DOM renderer. */
  webglLosses: number;
  disposables: Array<() => void>;
}

export type CreateTerminal = () => TermLike;

let windowsPtyBuildNumber: number | undefined;

/** `app_info().osBuild` bir kez okunup burada saklanır (faz4-spec §4.21). */
export function setWindowsPtyBuildNumber(buildNumber: number): void {
  windowsPtyBuildNumber = buildNumber;
}

/**
 * xterm theme from the resolved terminal colours (DESIGN_SYSTEM §8, D-057): the app theme's
 * terminal colours, a chosen catalogue scheme or an imported Windows Terminal scheme
 * (`resolveTerminalColors`). Kotilo themes carry today's tokens (`palette.ts`, kept in sync with
 * `index.css` by `palette.test.ts`).
 */
export function xtermThemeFor(colors: TerminalColors, translucent = false): NonNullable<ITerminalOptions["theme"]> {
  return {
    ...colors.ansi,
    // D-065: in a translucent window the cells let the window background through.
    background: translucent ? "#00000000" : colors.background,
    foreground: colors.foreground,
    cursor: colors.cursor,
    cursorAccent: colors.background,
    selectionBackground: colors.selection,
    selectionInactiveBackground: colors.selectionInactive ?? colors.selection,
  };
}

/** The terminal colours for the current settings and app theme. */
export function currentTerminalColors(): TerminalColors {
  const { terminal } = useSettingsStore.getState().settings;
  return resolveTerminalColors(terminal.colorScheme, terminal.importedSchemes, useResolvedTheme.getState().id);
}

/** D-065: the window background is translucent (Settings → Appearance → Background opacity). */
export function windowTranslucent(): boolean {
  return isWindowTranslucent(useSettingsStore.getState().settings);
}

/** What the terminal's box shows around the cells: its scheme background, or nothing when translucent. */
export function terminalBoxBackground(colors: TerminalColors): string {
  return windowTranslucent() ? "transparent" : colors.background;
}

const SCROLLBACK = 10000;
// DESIGN_SYSTEM §3: Geist Mono by default, Cascadia Code / Consolas as fallbacks.
const FONT_FAMILY = '"Geist Mono", "Cascadia Code", Consolas, monospace';
const FONT_SIZE = 15; // xterm'in kendi varsayılanı — settingsStore.DEFAULT_SETTINGS ile tutarlı

let fontSuggestion: string | null = null;

/** D-055: an installed Nerd Font (from `terminal_font_suggestion`), read once at startup. */
export function setTerminalFontSuggestion(family: string | null): void {
  fontSuggestion = family;
}

export function getTerminalFontSuggestion(): string | null {
  return fontSuggestion;
}

/**
 * The font family a terminal uses: the user's own setting as is; the default one gets the
 * detected Nerd Font in front, so prompt icons (oh-my-posh, starship…) render out of the box.
 */
export function effectiveTerminalFont(setting: string): string {
  const family = setting.trim() || FONT_FAMILY;
  if (family !== FONT_FAMILY || !fontSuggestion) return family;
  return `"${fontSuggestion.replace(/"/g, "")}", ${FONT_FAMILY}`;
}

function defaultCreateTerminal(): TermLike {
  const settings = useSettingsStore.getState().settings;
  return new Terminal({
    scrollback: SCROLLBACK,
    fontFamily: effectiveTerminalFont(settings.terminal.fontFamily),
    fontSize: settings.terminal.fontSize || FONT_SIZE,
    cursorBlink: true,
    cursorStyle: "bar",
    allowProposedApi: true,
    theme: xtermThemeFor(currentTerminalColors(), windowTranslucent()),
    // D-065: needed before `open()` for a translucent background; set always so the setting
    // applies live to open terminals.
    allowTransparency: true,
    windowsPty: windowsPtyBuildNumber ? { backend: "conpty", buildNumber: windowsPtyBuildNumber } : undefined,
  });
}

let createTerminalFactory: CreateTerminal = defaultCreateTerminal;

/** Testler için (faz4-spec §4.22): gerçek xterm yerine sahte bir terminal enjekte eder. */
export function setCreateTerminalFactory(factory: CreateTerminal): void {
  createTerminalFactory = factory;
}

/** Testler arası temizlik. */
export function resetCreateTerminalFactory(): void {
  createTerminalFactory = defaultCreateTerminal;
}

const entries = new Map<string, TermEntry>();

/** Yoksa oluşturur (idempotent) — `host`'u ve `term`'i bir kez kurar. */
export function getOrCreateEntry(tabId: string): TermEntry {
  const existing = entries.get(tabId);
  if (existing) return existing;

  const term = createTerminalFactory();
  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  // D-057: FitAddon leaves a strip of less than one cell; it shows the terminal background.
  host.style.background = terminalBoxBackground(currentTerminalColors());

  const entry: TermEntry = {
    tabId,
    term,
    host,
    channel: null,
    paneId: null,
    opened: false,
    fit: null,
    search: null,
    webgl: null,
    webglLosses: 0,
    disposables: [],
  };
  // D-068: OSC 52 clipboard writes (reads are never answered); the setting is read per write.
  const parser = (term as Partial<Pick<Terminal, "parser">>).parser;
  const osc52 = parser?.registerOscHandler(52, (data) => {
    if (useSettingsStore.getState().settings.terminal.osc52Clipboard === false) return true;
    const text = parseOsc52(data);
    if (text !== null) void clipboardWriteText(text).catch(() => {});
    return true;
  });
  if (osc52) entry.disposables.push(() => osc52.dispose());
  entries.set(tabId, entry);
  return entry;
}

/** D-068 "Reset terminal": turns off modes a crashed program left on; the shell keeps running. */
export function resetTerminalModes(tabId: string): void {
  entries.get(tabId)?.term.write(RESET_MODES_SEQUENCE);
}

/** D-068 "Copy recent output": the last rows of the buffer to the clipboard; false when empty. */
export async function copyRecentOutput(tabId: string): Promise<boolean> {
  const text = recentOutputText(readBufferTail(tabId, RECENT_OUTPUT_ROWS));
  if (text === "") return false;
  await clipboardWriteText(text);
  return true;
}

export function getEntry(tabId: string): TermEntry | undefined {
  return entries.get(tabId);
}

export function allEntries(): TermEntry[] {
  return Array.from(entries.values());
}

/**
 * Bu pane'in `Channel`'ını döner — yoksa oluşturur ve `onmessage`'ını `term.write`'a bağlar
 * (görünmeyen sekmeler de kendi buffer'ını günceller). `restart()` sonrası yeniden çağrılırsa
 * (kanal `dropChannel` ile boşaltıldıktan sonra) taze bir `Channel` kurar (faz4-spec §4.7).
 */
export function getChannel(tabId: string): Channel<ArrayBuffer> {
  const entry = getOrCreateEntry(tabId);
  if (!entry.channel) {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buf) => entry.term.write(new Uint8Array(buf as ArrayBuffer));
    entry.channel = channel;
  }
  return entry.channel;
}

/** Eski kanalın `onmessage`'ını boşaltır (restart öncesi, faz4-spec §4.7). */
export function dropChannel(tabId: string): void {
  const entry = entries.get(tabId);
  if (entry?.channel) entry.channel.onmessage = () => {};
  if (entry) entry.channel = null;
}

/** Sekme gövdesine bilgi satırı yazar (çıkış kodu, cwd düşmesi vb. — faz4-spec §2.2/§4.10). */
export function writeInfoLine(tabId: string, text: string): void {
  entries.get(tabId)?.term.write(`\r\n\x1b[90m${text}\x1b[0m\r\n`);
}

/** `term.focus()` — `` Ctrl+` `` odaklanma komutu için (gerçek `Terminal`'de mevcut). */
export function focusTerminal(tabId: string): void {
  const term = entries.get(tabId)?.term as { focus?: () => void } | undefined;
  term?.focus?.();
}

/** Whether the program in the tab turned on bracketed paste (DECSET 2004) – M4 composer send. */
export function bracketedPasteMode(tabId: string): boolean {
  const term = entries.get(tabId)?.term as { modes?: { bracketedPasteMode?: boolean } } | undefined;
  return term?.modes?.bracketedPasteMode === true;
}

interface BufferLike {
  length: number;
  getLine(y: number): { isWrapped?: boolean; translateToString(trimRight?: boolean): string } | undefined;
}

/**
 * The last `maxRows` rows of the tab's active xterm buffer as plain text lines (soft-wrapped
 * rows joined, right-trimmed, oldest first); `[]` when the tab has no terminal. M4 mission
 * control preview: the text stays in the webview, never logged or persisted (rule 5).
 */
export function readBufferTail(tabId: string, maxRows: number): string[] {
  const term = entries.get(tabId)?.term as { buffer?: { active?: BufferLike } } | undefined;
  const buffer = term?.buffer?.active;
  if (!buffer) return [];
  const rows: string[] = [];
  for (let y = Math.max(0, buffer.length - maxRows); y < buffer.length; y++) {
    const line = buffer.getLine(y);
    const text = line?.translateToString(false) ?? "";
    if (line?.isWrapped && rows.length > 0) rows[rows.length - 1] += text;
    else rows.push(text);
  }
  return rows.map((row) => row.trimEnd());
}

/** Pane kill + `term.dispose()` — yalnızca sekme kapatılınca çağrılır (unmount değil). */
export function disposeTerminal(tabId: string): void {
  const entry = entries.get(tabId);
  if (!entry) return;
  entries.delete(tabId);
  // Kanalı burada da boşalt (§6 LOW): backend'den gecikmeli gelen bir batch, artık yok olmuş
  // `term`'e `write` çağırmasın. `entries.delete` üstte olduğu için `dropChannel(tabId)`
  // artık haritada bulamaz — elimizdeki `entry` referansı üzerinden doğrudan yapıyoruz.
  if (entry.channel) {
    entry.channel.onmessage = () => {};
    entry.channel = null;
  }
  for (const dispose of entry.disposables) {
    try {
      dispose();
    } catch {
      // yut — dispose sırasında bir addon'un hata atması diğerlerini engellemesin
    }
  }
  try {
    entry.webgl?.dispose();
  } catch {
    // yut
  }
  try {
    entry.term.dispose();
  } catch {
    // yut
  }
}

/** Testler arası temizlik (kayıt defterini tamamen boşaltır, factory'yi sıfırlamaz). */
export function clearAllEntries(): void {
  for (const tabId of Array.from(entries.keys())) disposeTerminal(tabId);
}
