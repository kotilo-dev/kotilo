/**
 * The xterm view of one tab (faz4-spec §2.1, §2.3, §2.4, §2.6, §4.2, §4.6, §4.9). The xterm
 * instance itself lives in `terminalRegistry` – this component only `appendChild`s
 * `entry.host` into its own box, loads the addons (depending on visibility) and wires keyboard,
 * clipboard and links. **Unmount does not destroy `entry`** – workspace switches / panel
 * collapse are safe (see the `terminalRegistry.ts` header).
 */
import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { ImageAddon } from "@xterm/addon-image";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { useStrings } from "../../app/strings";
import {
  clipboardReadText,
  clipboardWriteText,
  fsResolveLink,
  openExternalUrl,
  ptyWrite,
  ptyWriteBytes,
  ptyResize,
  onFsChanged,
  type ResolvedLink,
} from "../../lib/ipc";
import { useViewerStore } from "../../stores/viewerStore";
import { useTerminalStore, type TerminalTab } from "../../stores/terminalStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useResolvedTheme } from "../../app/theme/resolvedTheme";
import { currentTerminalColors, effectiveTerminalFont, getOrCreateEntry, xtermThemeFor } from "./terminalRegistry";
import { routeKey } from "./keyRouting";
import { extractLinkCandidates } from "./linkCandidates";
import { buildCellColumnMap, cellRangeFromStringRange } from "./cellColumnMap";
import { countPastedLines, shouldWarnMultilinePaste } from "./pasteWarning";
import { PasteWarningModal } from "./PasteWarningModal";

const RESIZE_DEBOUNCE_MS = 50;
const LINK_CACHE_LIMIT = 500;

// --- Link resolution cache (LRU, 500 entries, fully cleared on fs:changed – §2.6) ------------

const linkCache = new Map<string, ResolvedLink | null>();
let linkCacheListenerInstalled = false;

function cacheKey(workspaceId: string, baseRel: string, candidate: string): string {
  return `${workspaceId}\0${baseRel}\0${candidate}`;
}

function cacheGet(key: string): ResolvedLink | null | undefined {
  if (!linkCache.has(key)) return undefined;
  const value = linkCache.get(key) ?? null;
  linkCache.delete(key);
  linkCache.set(key, value); // most recently used moves to the end (LRU)
  return value;
}

function cacheSet(key: string, value: ResolvedLink | null): void {
  if (linkCache.size >= LINK_CACHE_LIMIT) {
    const oldest = linkCache.keys().next().value;
    if (oldest !== undefined) linkCache.delete(oldest);
  }
  linkCache.set(key, value);
}

function installLinkCacheInvalidation(): void {
  if (linkCacheListenerInstalled) return;
  linkCacheListenerInstalled = true;
  void onFsChanged(() => linkCache.clear());
}

// --- Key routing: keydown decides, keypress/keyup carry the same decision (§4.2) ------------

interface KeyDecision {
  code: string;
  route: ReturnType<typeof routeKey>;
}

function shouldSwallow(e: KeyboardEvent, last: { current: KeyDecision | null }, hasSelection: boolean): boolean {
  if (e.type === "keydown") {
    const route = routeKey(e, true, hasSelection); // this handler only runs while the terminal has focus
    last.current = { code: e.code, route };
    return route !== "shell";
  }
  // keypress/keyup: re-apply the keydown decision of the same physical key (§4.2).
  if (last.current && last.current.code === e.code) return last.current.route !== "shell";
  return false;
}

export interface TerminalViewProps {
  workspaceId: string;
  tab: TerminalTab;
  visible: boolean;
}

export function TerminalView({ workspaceId, tab, visible }: TerminalViewProps) {
  const strings = useStrings();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // faz6-spec §7: text waiting to be pasted (the multi-line warning modal awaits confirmation).
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  // `entry.opened` is not React state (a registry mutation) – this counter is bumped to re-run
  // dependent effects (lazy start) when the ResizeObserver opens it late (see the §4.9 fix).
  const [openTick, setOpenTick] = useState(0);

  const entry = getOrCreateEntry(tab.id);
  const term = entry.term as unknown as Terminal;

  // Latest value of the `visible` prop – the ResizeObserver callback closes over its effect's
  // setup (`visible` is not in its deps, otherwise every visibility change would rebuild the
  // observer), so it reads the live value from here.
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  // --- attach the host to the DOM (a div created once – only detached on unmount) -----------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.appendChild(entry.host);
    return () => {
      if (entry.host.parentElement === container) container.removeChild(entry.host);
    };
  }, [entry]);

  // --- term.open + addons: the first moment the host is in the DOM AND its size is > 0 (§4.9).
  // A function because both the mount effect and the ResizeObserver below can trigger it – if
  // the panel starts at 0 width and is opened later (Ctrl+J), opening happens not in the first
  // mount effect but in the ResizeObserver round where the size becomes > 0.
  function openTerminalHost(): void {
    if (entry.opened || !visibleRef.current) return;
    const host = entry.host;
    if (host.clientWidth === 0 || host.clientHeight === 0) return;

    term.open(host);
    entry.opened = true;

    const fit = new FitAddon();
    term.loadAddon(fit);
    entry.fit = fit;

    const search = new SearchAddon();
    term.loadAddon(search);
    entry.search = search;

    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";

    // D-055: sixel and iTerm inline images (e.g. fastfetch logos). They reach xterm.js only through
    // the bundled ConPTY; the image cache is capped so a long scrollback of pictures stays small.
    term.loadAddon(new ImageAddon({ sixelSupport: true, iipSupport: true, storageLimit: 32 }));

    // §8a: Ctrl+click hint – an element with the `xterm-hover` class inside `Terminal.element`
    // (xterm.d.ts `ILinkHandler.hover` docs: this class lets mouse events "pass over" without
    // breaking the hover state of other links underneath).
    const tooltipHost = term.element ?? host;
    const tooltip = document.createElement("div");
    tooltip.className =
      "xterm-hover absolute z-50 whitespace-nowrap rounded-badge border border-border bg-surface-1 px-1.5 py-0.5 text-label text-text";
    tooltip.style.display = "none";
    tooltipHost.appendChild(tooltip);
    entry.disposables.push(() => tooltip.remove());

    const showTooltip = (event: MouseEvent, text: string) => {
      const rect = tooltipHost.getBoundingClientRect();
      tooltip.textContent = text;
      tooltip.style.left = `${event.clientX - rect.left + 8}px`;
      tooltip.style.top = `${event.clientY - rect.top + 16}px`;
      tooltip.style.display = "block";
    };
    const hideTooltip = () => {
      tooltip.style.display = "none";
    };

    // §4.6: web links also open only on Ctrl+click – the handler checks the modifier itself.
    term.loadAddon(
      new WebLinksAddon(
        (event, uri) => {
          if (!event.ctrlKey) return;
          void openExternalUrl(uri);
        },
        {
          hover: (event) => showTooltip(event, strings.terminal.ctrlClickToOpenLink),
          leave: () => hideTooltip(),
        },
      ),
    );

    installLinkCacheInvalidation();
    const linkProviderDisposable = term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = term.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) return callback(undefined);
        const text = line.translateToString(true);
        const candidates = extractLinkCandidates(text);
        if (candidates.length === 0) return callback(undefined);

        // §8b: string indices don't map 1:1 to cell columns (CJK/emoji width-2 cells) – map
        // them with the pure helper.
        const getCell = (x: number) => line.getCell(x);
        const colForIndex = buildCellColumnMap(term.cols, getCell);

        callback(
          candidates.map((c) => {
            const { startCol, endCol } = cellRangeFromStringRange(colForIndex, getCell, c.start, c.end);
            return {
              range: {
                start: { x: startCol + 1, y: bufferLineNumber },
                end: { x: endCol + 1, y: bufferLineNumber },
              },
              text: c.text,
              hover: (event: MouseEvent) => showTooltip(event, strings.terminal.ctrlClickToOpenFile),
              leave: () => hideTooltip(),
              activate: (event: MouseEvent) => {
                if (!event.ctrlKey) return;
                // §4.9 fix: read cwdRel from the store at activation time – the link provider is
                // registered once on open, so its closure holds a stale `tab.cwdRel` (the spawn
                // cwd may have fallen back).
                const latestCwdRel =
                  useTerminalStore.getState().byWorkspace[workspaceId]?.tabs.find((t) => t.id === tab.id)?.cwdRel ??
                  tab.cwdRel;
                void resolveAndOpenLink(workspaceId, latestCwdRel, c.text);
              },
            };
          }),
        );
      },
    });
    entry.disposables.push(() => linkProviderDisposable.dispose());

    requestAnimationFrame(() => fit.fit());
    setOpenTick((t) => t + 1); // entry.opened is not React state – trigger dependent effects (lazy start)
  }

  useEffect(() => {
    openTerminalHost();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, visible, term, workspaceId, tab.id]);

  // --- fit + pty_resize: on size change (while visible), 50ms debounce ----------------------
  useEffect(() => {
    const host = entry.host;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (host.clientWidth === 0 || host.clientHeight === 0) return;
        if (!entry.opened) {
          // §4.9 fix: if the panel started at size 0 the mount effect bailed out – the column
          // has now grown to > 0, finish opening here.
          openTerminalHost();
          if (!entry.opened) return;
        }
        entry.fit?.fit();
        if (tab.paneId) void ptyResize(tab.paneId, term.cols, term.rows);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(host);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, tab.paneId]);

  // --- refit when shown (rAF, §4.9) + hidden-to-visible transition ---------------------------
  useEffect(() => {
    if (!visible || !entry.opened) return;
    requestAnimationFrame(() => {
      entry.fit?.fit();
      if (tab.paneId) void ptyResize(tab.paneId, term.cols, term.rows);
    });
  }, [visible, entry, tab.paneId, term]);

  // --- WebGL only on visible terminals, after `document.fonts.ready` (§2.3) ------------------
  useEffect(() => {
    if (!visible || !entry.opened) {
      if (entry.webgl) {
        try {
          entry.webgl.dispose();
        } catch {
          // swallow
        }
        entry.webgl = null;
      }
      return;
    }
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (cancelled || entry.webgl || !visible) return;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          try {
            webgl.dispose();
          } catch {
            // swallow
          }
          if (entry.webgl === webgl) entry.webgl = null;
        });
        term.loadAddon(webgl);
        entry.webgl = webgl;
      } catch (err) {
        console.warn("[agenthub] WebGL addon unavailable, using the DOM renderer", err);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [visible, entry, term]);

  // --- live font/theme from settings (faz6-spec §1.4, §2, §7): same rule as for open editors,
  // here for all terminals – this component is mounted for every tab regardless of visibility
  // (see the TerminalPanel.tsx header), so each open terminal updates itself.
  useEffect(() => {
    function apply(s: ReturnType<typeof useSettingsStore.getState>["settings"]) {
      term.options.fontFamily = effectiveTerminalFont(s.terminal.fontFamily);
      term.options.fontSize = s.terminal.fontSize;
      const colors = currentTerminalColors();
      term.options.theme = xtermThemeFor(colors);
      // D-057: the host (and its box) show the terminal background, not `--bg`, around the cells.
      entry.host.style.background = colors.background;
      if (containerRef.current) containerRef.current.style.background = colors.background;
      if (entry.opened) {
        entry.fit?.fit();
        if (tab.paneId) void ptyResize(tab.paneId, term.cols, term.rows);
      }
    }
    apply(useSettingsStore.getState().settings);
    const unsubscribe = useSettingsStore.subscribe((state, prevState) => {
      const s = state.settings;
      const prev = prevState.settings;
      if (
        s.terminal.fontFamily !== prev.terminal.fontFamily ||
        s.terminal.fontSize !== prev.terminal.fontSize ||
        s.terminal.colorScheme !== prev.terminal.colorScheme ||
        s.terminal.importedSchemes !== prev.terminal.importedSchemes
      ) {
        apply(s);
      }
    });
    const unsubscribeTheme = useResolvedTheme.subscribe((state, prev) => {
      if (state.theme !== prev.theme || state.id !== prev.id) apply(useSettingsStore.getState().settings);
    });
    return () => {
      unsubscribe();
      unsubscribeTheme();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, entry, tab.paneId]);

  // --- copy on select (faz6-spec §7, review #17 fix): `term.onSelectionChange` fires on EVERY
  // selection change – including the PROGRAMMATIC highlight from the search box's
  // `findNext`/`findPrevious` (also a "selection" to xterm). We used to listen to it with a
  // debounce – result: even jumping to a search match overwrote the clipboard. Now only the
  // USER's mouse selection is copied: on `mouseup` (mouse released) the current selection is
  // written to the clipboard – not while dragging, and programmatic (search) selections never
  // produce a `mouseup`, so they never trigger it.
  useEffect(() => {
    const host = entry.host;
    const handler = () => {
      if (!useSettingsStore.getState().settings.terminal.copyOnSelect) return;
      if (term.hasSelection()) void clipboardWriteText(term.getSelection());
    };
    host.addEventListener("mouseup", handler);
    return () => host.removeEventListener("mouseup", handler);
  }, [entry, term]);

  // --- native `paste` DOM event (review #15 fix): xterm installs a `paste` listener on its own
  // textarea (bubble phase) and pastes directly – without ever seeing our multi-line warning
  // decision (`pasteText`). The `keydown` of `Ctrl+V` is `preventDefault()`ed in
  // `attachCustomKeyEventHandler` below, so the browser never fires `paste` for it (no double
  // paste for the same key) – but `Shift+Insert` is classified "shell" by `routeKey` (no special
  // `keydown` handler), so its native `paste` reached xterm unchecked. A listener installed here
  // in the CAPTURE phase runs BEFORE xterm's own (bubble) listener; `stopPropagation` keeps that
  // one from running at all.
  useEffect(() => {
    const textarea = term.textarea;
    if (!textarea) return;
    const handler = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text");
      if (!text) return; // no text (e.g. an image): leave it to xterm/the browser
      e.preventDefault();
      e.stopPropagation();
      pasteText(term, text, setPendingPaste);
    };
    textarea.addEventListener("paste", handler, true);
    return () => textarea.removeEventListener("paste", handler, true);
    // `term.textarea` only exists after `term.open()` – `openTick` re-binds at the right moment
    // (also for panels opened late; same pattern as the lazy-start effect).
  }, [term, openTick]);

  // --- lazy start: a visible idle tab with an open host (§4.9: host size > 0) starts on its own.
  // Plain shell tabs always (§2.2); agent tabs only with `autoStart` (D21: true for tabs just
  // created via "New agent ▶", false/absent for restored ones – only new tabs start
  // automatically, restored ones show the Start overlay). `openTick` dependency: `entry.opened`
  // is not React state; needed to re-run this effect when the ResizeObserver opens it late.
  useEffect(() => {
    if (!visible || !entry.opened || tab.status !== "idle") return;
    if (tab.agentCommand !== null && !tab.autoStart) return;
    void useTerminalStore.getState().start(workspaceId, tab.id);
  }, [visible, entry.opened, tab.status, tab.agentCommand, tab.autoStart, workspaceId, tab.id, openTick]);

  // --- xterm -> pty: only while "running" (§4.8) ----------------------------------------------
  useEffect(() => {
    const dataSub = term.onData((data) => {
      const latest = useTerminalStore.getState().byWorkspace[workspaceId]?.tabs.find((t) => t.id === tab.id);
      if (latest?.status === "running" && latest.paneId) void ptyWrite(latest.paneId, data);
    });
    const binarySub = term.onBinary((data) => {
      const latest = useTerminalStore.getState().byWorkspace[workspaceId]?.tabs.find((t) => t.id === tab.id);
      if (latest?.status !== "running" || !latest.paneId) return;
      const bytes = Array.from(data, (ch) => ch.charCodeAt(0) & 0xff);
      void ptyWriteBytes(latest.paneId, bytes);
    });
    const titleSub = term.onTitleChange((title) => {
      useTerminalStore.getState().setAutoTitle(workspaceId, tab.id, title);
    });
    return () => {
      dataSub.dispose();
      binarySub.dispose();
      titleSub.dispose();
    };
  }, [term, workspaceId, tab.id]);

  // --- key routing + terminal-local shortcuts (§2.3, §2.4, §4.2) -----------------------------
  useEffect(() => {
    const last = { current: null as KeyDecision | null };
    term.attachCustomKeyEventHandler((e) => {
      const swallow = shouldSwallow(e, last, term.hasSelection());
      // §4.2/§4.3: xterm 6 ignores `defaultPrevented` – returning `false` stops sending to the
      // pty but does not prevent the browser's default action (e.g. a shortcut's native
      // behaviour); so it is called explicitly here.
      if (swallow) e.preventDefault();
      if (e.type === "keydown" && last.current?.route === "terminal") {
        handleTerminalLocalShortcut(e, term, () => setSearchOpen((s) => !s), setPendingPaste);
      }
      return !swallow;
    });
  }, [term]);

  // --- right click: copy if there is a selection, else paste (§2.3, §4.3) --------------------
  useEffect(() => {
    const host = entry.host;
    const handler = (e: MouseEvent) => {
      e.preventDefault();
      if (term.hasSelection()) {
        void clipboardWriteText(term.getSelection());
      } else {
        void pasteFromClipboard(term, false, setPendingPaste);
      }
    };
    host.addEventListener("contextmenu", handler);
    return () => host.removeEventListener("contextmenu", handler);
  }, [entry, term]);

  const showAgentPrompt = tab.status === "idle" && tab.agentCommand !== null;
  const showExitBar = tab.status === "exited";

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={containerRef} className="h-full min-h-0 w-full" />

      {showAgentPrompt && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-bg">
          <button
            type="button"
            className="rounded bg-accent px-3 py-1 text-xs font-medium text-on-accent"
            onClick={() => void useTerminalStore.getState().start(workspaceId, tab.id)}
          >
            {strings.terminal.startAgent(tab.agentCommand!)}
          </button>
          <button
            type="button"
            className="rounded px-3 py-1 text-xs text-muted"
            onClick={() => void useTerminalStore.getState().start(workspaceId, tab.id, { shellOnly: true })}
          >
            {strings.terminal.startShellOnly}
          </button>
        </div>
      )}

      {showExitBar && (
        <div className="absolute inset-x-0 top-0 flex items-center justify-end gap-2 bg-surface-1 px-2 py-1 text-xs">
          <button
            type="button"
            className="rounded px-2 py-0.5 text-text"
            onClick={() => void useTerminalStore.getState().restart(workspaceId, tab.id)}
          >
            {strings.terminal.restart}
          </button>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-muted"
            onClick={() => void useTerminalStore.getState().closeTab(workspaceId, tab.id)}
          >
            {strings.terminal.close}
          </button>
        </div>
      )}

      {searchOpen && (
        <div className="absolute right-2 top-2 flex items-center gap-1 rounded border border-border bg-surface-1 px-1.5 py-1 text-xs">
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setSearchOpen(false);
                term.focus();
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) entry.search?.findPrevious(searchQuery);
                else entry.search?.findNext(searchQuery);
              }
            }}
            placeholder={strings.terminal.searchPlaceholder}
            className="w-32 bg-transparent text-text outline-none"
          />
          <button type="button" title={strings.terminal.searchPrev} onClick={() => entry.search?.findPrevious(searchQuery)}>
            ↑
          </button>
          <button type="button" title={strings.terminal.searchNext} onClick={() => entry.search?.findNext(searchQuery)}>
            ↓
          </button>
          <button
            type="button"
            title={strings.terminal.closeSearchTooltip}
            onClick={() => {
              setSearchOpen(false);
              term.focus();
            }}
          >
            ×
          </button>
        </div>
      )}

      {pendingPaste !== null && (
        <PasteWarningModal
          lines={countPastedLines(pendingPaste)}
          onCancel={() => {
            setPendingPaste(null);
            term.focus();
          }}
          onConfirm={(dontAskAgain) => {
            term.paste(pendingPaste);
            if (dontAskAgain) useSettingsStore.getState().update({ terminal: { warnMultilinePaste: false } });
            setPendingPaste(null);
            term.focus();
          }}
        />
      )}
    </div>
  );
}

/**
 * If `text` is multi-line, bracketed paste is off and the setting is on, it does not paste
 * directly – it hands over to the caller via `onNeedsConfirm` (faz6-spec §7 modal); otherwise it
 * pastes. The single place that runs already obtained text through this decision – `Ctrl+V`
 * (`pasteFromClipboard`, async `clipboardReadText`) AND the native `paste` DOM event (sync
 * `event.clipboardData`) share it (review #15: two triggers must not carry two decision paths).
 */
function pasteText(term: Terminal, text: string, onNeedsConfirm: (text: string) => void): void {
  const warnEnabled = useSettingsStore.getState().settings.terminal.warnMultilinePaste;
  if (shouldWarnMultilinePaste(text, term.modes.bracketedPasteMode, warnEnabled)) {
    onNeedsConfirm(text);
    return;
  }
  term.paste(text);
}

/** Reads the clipboard via the Tauri API; without text (e.g. an image) `forwardCtrlVWhenNoText` forwards ^V to the shell. */
async function pasteFromClipboard(
  term: Terminal,
  forwardCtrlVWhenNoText: boolean,
  onNeedsConfirm: (text: string) => void,
): Promise<void> {
  let text: string | null = null;
  try {
    text = await clipboardReadText();
  } catch {
    // swallow – an unreadable clipboard counts as no text
  }
  if (!text) {
    if (forwardCtrlVWhenNoText) term.input("");
    return;
  }
  pasteText(term, text, onNeedsConfirm);
}

/**
 * `Ctrl+Shift+C/V/F`, `Ctrl+V` and `Ctrl+C` with a selection – `routeKey` classifies these as
 * `"terminal"` (§2.3, §4.3). keydown is `preventDefault`ed, so the browser fires no `paste`
 * event → pasting happens once.
 */
function handleTerminalLocalShortcut(
  e: KeyboardEvent,
  term: Terminal,
  toggleSearch: () => void,
  onNeedsPasteConfirm: (text: string) => void,
): void {
  e.preventDefault();
  if (e.key.toLowerCase() === "c") {
    if (term.hasSelection()) {
      void clipboardWriteText(term.getSelection());
      // Like Windows Terminal: the selection clears after copying, the next Ctrl+C is SIGINT again.
      if (!e.shiftKey) term.clearSelection();
    }
  } else if (e.key.toLowerCase() === "v") {
    // Plain Ctrl+V: without text on the clipboard (e.g. an image) ^V goes to the shell – claude
    // takes clipboard images on Ctrl+V; Ctrl+Shift+V only pastes text.
    void pasteFromClipboard(term, !e.shiftKey, onNeedsPasteConfirm);
  } else if (e.key.toLowerCase() === "f") {
    toggleSearch();
  }
}

async function resolveAndOpenLink(workspaceId: string, baseRel: string, candidate: string): Promise<void> {
  const key = cacheKey(workspaceId, baseRel, candidate);
  let resolved = cacheGet(key);
  if (resolved === undefined) {
    try {
      resolved = await fsResolveLink(workspaceId, baseRel, candidate);
    } catch {
      resolved = null;
    }
    cacheSet(key, resolved);
  }
  if (!resolved) return;
  useViewerStore
    .getState()
    .openFile(workspaceId, resolved.rel, { pinned: true, line: resolved.line ?? undefined, column: resolved.column });
}
