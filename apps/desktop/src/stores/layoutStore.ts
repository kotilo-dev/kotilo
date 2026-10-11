/**
 * Panel boyutları + görünürlük — tek kalıcılık kaynağı Rust `state.json`
 * (`%APPDATA%\kotilo\state.json`, bkz. `src/lib/ipc.ts`).
 *
 * `react-resizable-panels`'in kendi `autoSaveId`'si KULLANILMAZ (todo.md Faz 1):
 * boyutlar bu store'dan okunur/yazılır, böylece ileride başka store'lar aynı
 * `state.json`'a yazarken tek bir kaynağı bozma riski olmaz.
 *
 * Layout hazır olmadan (henüz `%APPDATA%`'dan yüklenmeden) paneller `defaultSize` ile
 * render edilirse önce varsayılan boyutla, sonra kaydedilmiş boyutla "zıplama" (flicker)
 * olur — bu yüzden `status` alanı `"loading"` iken `App.tsx` panelleri hiç render etmez.
 *
 * Kalıcılık düzeltmesi (faz2-spec §1): bu store artık yalnızca kendi `"layout"` slice'ını
 * `save_state_slice` ile yazar — `state.json`'daki diğer anahtarları (`workspaces` vb.)
 * tutmak için ham state'i kendi kopyasında saklamaz (o iş artık backend'in process-ömürlü
 * `StateStore`'unda).
 */
import { create } from "zustand";
import { loadState, saveStateSlice } from "../lib/ipc";

export interface ColumnSizes {
  left: number;
  terminal: number;
  viewer: number;
}

export interface LeftSplitSizes {
  workspaces: number;
  agents: number;
}

export interface LayoutSlice {
  leftVisible: boolean;
  terminalVisible: boolean;
  viewerVisible: boolean;
  columnSizes: ColumnSizes;
  leftSplitSizes: LeftSplitSizes;
  /** M4: the workspace timeline rail (right of the column group) and its width in px. */
  timelineVisible: boolean;
  timelineWidth: number;
}

export const DEFAULT_LAYOUT: LayoutSlice = {
  leftVisible: true,
  terminalVisible: true,
  viewerVisible: true,
  columnSizes: { left: 22, terminal: 46, viewer: 32 },
  leftSplitSizes: { workspaces: 55, agents: 45 },
  timelineVisible: true,
  timelineWidth: 300,
};

export const TIMELINE_MIN_WIDTH = 220;
export const TIMELINE_MAX_WIDTH = 560;

function clampTimelineWidth(width: number): number {
  return Math.round(Math.min(TIMELINE_MAX_WIDTH, Math.max(TIMELINE_MIN_WIDTH, width)));
}

const VISIBILITY_KEY = {
  left: "leftVisible",
  terminal: "terminalVisible",
  viewer: "viewerVisible",
} as const satisfies Record<keyof ColumnSizes, keyof LayoutSlice>;

const STATE_KEY = "layout";
const SAVE_DEBOUNCE_MS = 500;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Diskten okunan (eksik/kısmi/bozuk olabilecek) veriyi varsayılanlarla birleştirir.
 * Her alan ayrı ayrı doğrulanır ki eski/eksik bir `state.json` uygulamayı bozmasın.
 */
export function mergeWithDefaults(partial: unknown): LayoutSlice {
  const p = (partial ?? {}) as Partial<Record<keyof LayoutSlice, unknown>>;

  const columnSizesRaw = (p.columnSizes ?? {}) as Partial<ColumnSizes>;
  const columnSizes: ColumnSizes = {
    left: isFiniteNumber(columnSizesRaw.left) ? columnSizesRaw.left : DEFAULT_LAYOUT.columnSizes.left,
    terminal: isFiniteNumber(columnSizesRaw.terminal)
      ? columnSizesRaw.terminal
      : DEFAULT_LAYOUT.columnSizes.terminal,
    viewer: isFiniteNumber(columnSizesRaw.viewer) ? columnSizesRaw.viewer : DEFAULT_LAYOUT.columnSizes.viewer,
  };

  const leftSplitRaw = (p.leftSplitSizes ?? {}) as Partial<LeftSplitSizes>;
  const leftSplitSizes: LeftSplitSizes = {
    workspaces: isFiniteNumber(leftSplitRaw.workspaces)
      ? leftSplitRaw.workspaces
      : DEFAULT_LAYOUT.leftSplitSizes.workspaces,
    agents: isFiniteNumber(leftSplitRaw.agents) ? leftSplitRaw.agents : DEFAULT_LAYOUT.leftSplitSizes.agents,
  };

  return {
    leftVisible: typeof p.leftVisible === "boolean" ? p.leftVisible : DEFAULT_LAYOUT.leftVisible,
    terminalVisible: typeof p.terminalVisible === "boolean" ? p.terminalVisible : DEFAULT_LAYOUT.terminalVisible,
    viewerVisible: typeof p.viewerVisible === "boolean" ? p.viewerVisible : DEFAULT_LAYOUT.viewerVisible,
    columnSizes,
    leftSplitSizes,
    timelineVisible: typeof p.timelineVisible === "boolean" ? p.timelineVisible : DEFAULT_LAYOUT.timelineVisible,
    timelineWidth: isFiniteNumber(p.timelineWidth) ? clampTimelineWidth(p.timelineWidth) : DEFAULT_LAYOUT.timelineWidth,
  };
}

interface LayoutStore {
  status: "loading" | "ready";
  layout: LayoutSlice;

  init: () => Promise<void>;
  toggleLeft: () => void;
  toggleTerminal: () => void;
  toggleViewer: () => void;
  /** Panel sürüklenerek kapatıldığında/açıldığında görünürlüğü store'a yansıtır (değişiklik yoksa no-op). */
  setVisible: (slot: keyof ColumnSizes, visible: boolean) => void;
  /** Yalnızca görünen panellerin boyutu güncellenir; gizli panellerin son bilinen boyutu korunur. */
  setColumnSizes: (sizes: Partial<ColumnSizes>) => void;
  setLeftSplitSizes: (sizes: Partial<LeftSplitSizes>) => void;
  toggleTimeline: () => void;
  /** Clamped to `TIMELINE_MIN_WIDTH`…`TIMELINE_MAX_WIDTH`. */
  setTimelineWidth: (width: number) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSave(layout: LayoutSlice) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    // Fire-and-forget: `saveStateSlice`'s `invoke` wrapper already logs a failure
    // (faz7-spec §9.5); `.catch` here only silences the resulting unhandled rejection.
    void saveStateSlice(STATE_KEY, layout).catch(() => {});
  }, SAVE_DEBOUNCE_MS);
}

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  status: "loading",
  layout: DEFAULT_LAYOUT,

  init: async () => {
    try {
      const raw = await loadState();
      const layout = mergeWithDefaults(raw[STATE_KEY]);
      set({ layout, status: "ready" });
    } catch {
      // Yükleme başarısız olsa bile uygulama varsayılanlarla açılabilmeli.
      set({ layout: DEFAULT_LAYOUT, status: "ready" });
    }
  },

  toggleLeft: () => {
    const layout = { ...get().layout, leftVisible: !get().layout.leftVisible };
    set({ layout });
    scheduleSave(layout);
  },

  toggleTerminal: () => {
    const layout = { ...get().layout, terminalVisible: !get().layout.terminalVisible };
    set({ layout });
    scheduleSave(layout);
  },

  toggleViewer: () => {
    const layout = { ...get().layout, viewerVisible: !get().layout.viewerVisible };
    set({ layout });
    scheduleSave(layout);
  },

  setVisible: (slot, visible) => {
    const key = VISIBILITY_KEY[slot];
    if (get().layout[key] === visible) return;
    const layout = { ...get().layout, [key]: visible };
    set({ layout });
    scheduleSave(layout);
  },

  setColumnSizes: (partial) => {
    const layout = { ...get().layout, columnSizes: { ...get().layout.columnSizes, ...partial } };
    set({ layout });
    scheduleSave(layout);
  },

  setLeftSplitSizes: (partial) => {
    const layout = {
      ...get().layout,
      leftSplitSizes: { ...get().layout.leftSplitSizes, ...partial },
    };
    set({ layout });
    scheduleSave(layout);
  },

  toggleTimeline: () => {
    const layout = { ...get().layout, timelineVisible: !get().layout.timelineVisible };
    set({ layout });
    scheduleSave(layout);
  },

  setTimelineWidth: (width) => {
    const timelineWidth = clampTimelineWidth(width);
    if (get().layout.timelineWidth === timelineWidth) return;
    const layout = { ...get().layout, timelineWidth };
    set({ layout });
    scheduleSave(layout);
  },
}));
