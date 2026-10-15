/**
 * Viewer sekme yönetimi (faz3-spec §2 "viewerStore", §5 revizyonu bağlayıcı). Faz 2 stub'unun
 * yerini alır; `openFile(workspaceId, rel, {pinned})` imzası korunur (SPEC §5 gereği).
 *
 * Workspace başına `{ tabs, activeTabId }`; görünen sekmeler = **aktif workspace**'in
 * sekmeleri (ViewerPanel `workspaceStore.activeId` ile birlikte okur). Kalıcılık `"viewer"`
 * state slice'ında, 500ms debounce.
 */
import { create } from "zustand";
import { batchFsChanges } from "../lib/fsBatch";
import {
  fsExists,
  loadState,
  onFsChanged,
  onFsRescan,
  onWorkspacesChanged,
  saveStateSlice,
  workspaceList,
} from "../lib/ipc";
import { getRenderer } from "../features/viewer/getRenderer";
import { isSameOrDescendant, parentRel } from "../features/workspaces/paths";
import { docKey, rekeyDocsForRetarget, useDocumentStore } from "./documentStore";

export type ViewerMode = "edit" | "preview" | "split";

export interface RevealTarget {
  line: number;
  column: number | null;
}

export interface ViewerTab {
  id: string;
  rel: string;
  pinned: boolean;
  /** Yalnızca markdown/html/svg için anlamlı (§5.6: varsayılan `"preview"`). */
  mode?: ViewerMode;
  /** fs:changed/fs:rescan sonrası dosya bulunamadı ama belge dirty olduğu için sekme kapatılmadı. */
  missing: boolean;
  /**
   * Terminal dosya yolu linki (faz4-spec §2.6): TextEditor hazır olunca bu satır/sütuna
   * kaydırır, sonra `clearReveal` ile temizler — kalıcı değildir, `PersistedTab`'a girmez.
   */
  revealTarget?: RevealTarget | null;
  /** M4: a read-only HEAD ↔ working copy diff of `rel` (timeline rail); never persisted. */
  diff?: boolean;
}

interface WorkspaceViewerState {
  tabs: ViewerTab[];
  activeTabId: string | null;
}

interface PersistedTab {
  rel: string;
  pinned: boolean;
  mode?: ViewerMode;
}

interface PersistedWorkspaceViewer {
  tabs: PersistedTab[];
  activeRel: string | null;
}

type PersistedViewerState = Record<string, PersistedWorkspaceViewer>;

const STATE_KEY = "viewer";
const SAVE_DEBOUNCE_MS = 500;

interface ViewerStore {
  ready: boolean;
  byWorkspace: Record<string, WorkspaceViewerState>;

  init: () => Promise<void>;

  /**
   * Tek tık → `{pinned:false}` (önizleme), çift tık / ağaçtan Enter → `{pinned:true}`.
   * `line`/`column` (faz4-spec §2.6, terminal dosya yolu linki): TextEditor'ü o satıra
   * kaydırır; markdown/html sekmelerinde mod `edit`'e geçer (kaynağı görmeden kaydırma anlamsız).
   */
  openFile: (workspaceId: string, rel: string, opts?: { pinned?: boolean; line?: number; column?: number | null }) => void;
  /** M4: opens (or activates) the diff tab of `rel`, pinned; separate from the file's own tab. */
  openDiff: (workspaceId: string, rel: string) => void;
  activate: (workspaceId: string, tabId: string) => void;
  closeTab: (workspaceId: string, tabId: string) => void;
  /** Düzenleme başlaması: önizleme sekmesini kalıcı sekmeye çevirir (no-op zaten pinliyse). */
  pin: (workspaceId: string, tabId: string) => void;
  setMode: (workspaceId: string, tabId: string, mode: ViewerMode) => void;
  /** `TextEditor` `revealTarget`'ı uyguladıktan sonra çağırır — kalıcı olmadığı için tekrar tetiklenmesin. */
  clearReveal: (workspaceId: string, tabId: string) => void;
  /** §5.8: dosya/klasör yeniden adlandırıldığında sekmeleri ve belge anahtarlarını taşır. */
  retarget: (workspaceId: string, oldRel: string, newRel: string) => void;
}

let nextTabId = 1;
function makeTabId(): string {
  return `tab-${nextTabId++}`;
}

function defaultModeFor(rel: string): ViewerMode | undefined {
  const kind = getRenderer(rel);
  // §5.6: markdown/html/svg sekmeleri "preview" ile açılır (HTML/SVG "Source" = "edit").
  if (kind === "markdown" || kind === "html" || kind === "svg") return "preview";
  return undefined;
}

function isDocDirty(workspaceId: string, rel: string): boolean {
  return useDocumentStore.getState().docs[docKey(workspaceId, rel)]?.dirty ?? false;
}

function serialize(byWorkspace: Record<string, WorkspaceViewerState>): PersistedViewerState {
  const out: PersistedViewerState = {};
  for (const [workspaceId, ws] of Object.entries(byWorkspace)) {
    const activeTab = ws.tabs.find((t) => t.id === ws.activeTabId && !t.diff);
    out[workspaceId] = {
      tabs: ws.tabs.filter((t) => !t.diff).map((t) => ({ rel: t.rel, pinned: t.pinned, mode: t.mode })),
      activeRel: activeTab?.rel ?? null,
    };
  }
  return out;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function schedulePersist(byWorkspace: Record<string, WorkspaceViewerState>): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    // Fire-and-forget: `saveStateSlice`'s `invoke` wrapper already logs a failure
    // (faz7-spec §9.5); `.catch` here only silences the resulting unhandled rejection.
    void saveStateSlice(STATE_KEY, serialize(byWorkspace)).catch(() => {});
  }, SAVE_DEBOUNCE_MS);
}

type Getter = () => ViewerStore;
type Setter = (partial: Partial<ViewerStore> | ((s: ViewerStore) => Partial<ViewerStore>)) => void;

function removeTab(set: Setter, workspaceId: string, tabId: string): void {
  set((s) => {
    const ws = s.byWorkspace[workspaceId];
    if (!ws) return {};
    const idx = ws.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return {};
    const tabs = ws.tabs.filter((t) => t.id !== tabId);
    let activeTabId = ws.activeTabId;
    if (activeTabId === tabId) {
      const neighbor = tabs[idx] ?? tabs[idx - 1];
      activeTabId = neighbor?.id ?? null;
    }
    return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { tabs, activeTabId } } };
  });
}

function setMissing(set: Setter, workspaceId: string, tabId: string, missing: boolean): void {
  set((s) => {
    const ws = s.byWorkspace[workspaceId];
    if (!ws) return {};
    const tabs = ws.tabs.map((t) => (t.id === tabId && t.missing !== missing ? { ...t, missing } : t));
    if (tabs === ws.tabs) return {};
    return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...ws, tabs } } };
  });
}

/**
 * `fs:changed`in `dirs`i ile eşleşen (veya `fs:rescan` için tüm) sekmeleri var olma açısından
 * denetler. Var olma kontrolü `fs_exists` ile (finding #8) — `fs_stat` gibi hash hesaplamaz,
 * yalnızca bir boole döner; bu yol yalnızca "dosya hâlâ orada mı" sorusuyla ilgilenir.
 */
async function checkTouchedTabs(
  get: Getter,
  set: Setter,
  workspaceId: string,
  matches: (rel: string) => boolean,
): Promise<void> {
  const ws = get().byWorkspace[workspaceId];
  if (!ws) return;
  // Diff tabs stay open for deleted files (HEAD vs nothing) and refresh themselves.
  const affected = ws.tabs.filter((t) => !t.diff && matches(t.rel));
  for (const tab of affected) {
    let exists: boolean;
    try {
      exists = await fsExists(workspaceId, tab.rel);
    } catch {
      exists = false; // beklenmeyen hata — dosya yokmuş gibi ele al (önceki fs_stat davranışıyla aynı güvenli taraf)
    }
    if (exists) {
      if (tab.missing) setMissing(set, workspaceId, tab.id, false);
    } else if (isDocDirty(workspaceId, tab.rel)) {
      setMissing(set, workspaceId, tab.id, true);
    } else {
      removeTab(set, workspaceId, tab.id);
    }
  }
}

let listenersInstalled = false;

function installListeners(get: Getter, set: Setter): void {
  if (listenersInstalled) return;
  listenersInstalled = true;

  void onWorkspacesChanged((next) => {
    const validIds = new Set(next.workspaces.map((w) => w.id));
    set((s) => {
      let changed = false;
      const byWorkspace = { ...s.byWorkspace };
      for (const id of Object.keys(byWorkspace)) {
        if (!validIds.has(id)) {
          delete byWorkspace[id];
          changed = true;
        }
      }
      return changed ? { byWorkspace } : {};
    });
  });

  void onFsChanged(batchFsChanges(({ workspaceId, dirs }) => {
    // finding #11: `dirs` yalnızca üst düzey değişen klasörleri listeler (ör. bir klasör dışarıdan
    // yeniden adlandırılınca yalnızca onun *ebeveyni* gelir, kendi altındaki iç içe yollar değil) —
    // eşitlik yerine soyundan gelme kontrolü, iç içe sekmelerin de denetlenmesini sağlar.
    void checkTouchedTabs(get, set, workspaceId, (rel) => dirs.some((d) => isSameOrDescendant(parentRel(rel), d)));
  }));

  void onFsRescan(({ workspaceId }) => {
    void checkTouchedTabs(get, set, workspaceId, () => true);
  });
}

/** finding #16: `init()` yeniden giriş korumalı — StrictMode/çift mount'ta eşzamanlı iki çağrı
 * birbirini ezmesin (ikinci çağrı, ilk henüz sürerken hesaplanmaya başlanan `byWorkspace`'i
 * `set` ile üzerine yazıp o aradaki `openFile`/vb. çağrılarını kaybetmesin diye). */
let initPromise: Promise<void> | null = null;

export const useViewerStore = create<ViewerStore>((set, get) => ({
  ready: false,
  byWorkspace: {},

  init: () => {
    if (get().ready) return Promise.resolve();
    if (initPromise) return initPromise;

    initPromise = (async () => {
      let persisted: PersistedViewerState = {};
      try {
        const raw = await loadState();
        const rawViewer = raw[STATE_KEY];
        if (rawViewer && typeof rawViewer === "object") persisted = rawViewer as PersistedViewerState;
      } catch {
        persisted = {};
      }

      let validWorkspaceIds: Set<string>;
      try {
        const wsState = await workspaceList();
        validWorkspaceIds = new Set(wsState.workspaces.map((w) => w.id));
      } catch {
        // Liste alınamadıysa hiçbir şeyi (yanlışlıkla) atma; sonraki `workspaces:changed` düzeltir.
        validWorkspaceIds = new Set(Object.keys(persisted));
      }

      const byWorkspace: Record<string, WorkspaceViewerState> = {};
      for (const [workspaceId, entry] of Object.entries(persisted)) {
        if (!validWorkspaceIds.has(workspaceId)) continue;
        const tabs: ViewerTab[] = [];
        for (const t of entry.tabs ?? []) {
          let exists: boolean;
          try {
            exists = await fsExists(workspaceId, t.rel);
          } catch {
            exists = false;
          }
          if (!exists) continue; // açılışta dosyası olmayan sekme sessizce düşer
          tabs.push({ id: makeTabId(), rel: t.rel, pinned: t.pinned, mode: t.mode, missing: false });
        }
        if (tabs.length === 0) continue;
        const active = tabs.find((t) => t.rel === entry.activeRel) ?? tabs[tabs.length - 1]!;
        byWorkspace[workspaceId] = { tabs, activeTabId: active.id };
      }

      set({ byWorkspace, ready: true });
      installListeners(get, set);
    })().finally(() => {
      initPromise = null;
    });

    return initPromise;
  },

  openFile: (workspaceId, rel, opts) => {
    const pinned = opts?.pinned ?? false;
    const line = opts?.line;
    const revealTarget: RevealTarget | null = line !== undefined ? { line, column: opts?.column ?? null } : null;
    const kind = getRenderer(rel);
    const forceEditForReveal = revealTarget !== null && (kind === "markdown" || kind === "html");

    set((s) => {
      const ws = s.byWorkspace[workspaceId] ?? { tabs: [], activeTabId: null };
      const existingIdx = ws.tabs.findIndex((t) => t.rel === rel && !t.diff);
      if (existingIdx !== -1) {
        const existing = ws.tabs[existingIdx]!;
        // §2/§5.6: çift tık (pinned:true) zaten açık bir önizleme sekmesini de pin'ler;
        // tek tık (pinned:false) yalnızca aktif yapar, pin durumunu değiştirmez.
        const shouldPin = pinned && !existing.pinned;
        const tabs = ws.tabs.map((t, i) =>
          i === existingIdx
            ? {
                ...t,
                pinned: shouldPin ? true : t.pinned,
                mode: forceEditForReveal ? "edit" : t.mode,
                revealTarget: revealTarget ?? t.revealTarget,
              }
            : t,
        );
        return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { tabs, activeTabId: existing.id } } };
      }

      let tabs = ws.tabs;
      if (!pinned) {
        const previewIdx = tabs.findIndex((t) => !t.pinned && !t.diff);
        if (previewIdx !== -1) {
          const previewTab = tabs[previewIdx]!;
          if (isDocDirty(workspaceId, previewTab.rel)) {
            // Dirty önizleme değiştirilmez — önce kalıcı sekmeye çevrilir (§2).
            tabs = tabs.map((t, i) => (i === previewIdx ? { ...t, pinned: true } : t));
          } else {
            tabs = tabs.filter((_, i) => i !== previewIdx);
          }
        }
      }

      const newTab: ViewerTab = {
        id: makeTabId(),
        rel,
        pinned,
        mode: forceEditForReveal ? "edit" : defaultModeFor(rel),
        missing: false,
        revealTarget,
      };
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { tabs: [...tabs, newTab], activeTabId: newTab.id } } };
    });
    schedulePersist(get().byWorkspace);
  },

  openDiff: (workspaceId, rel) => {
    set((s) => {
      const ws = s.byWorkspace[workspaceId] ?? { tabs: [], activeTabId: null };
      const existing = ws.tabs.find((t) => t.rel === rel && t.diff);
      if (existing) return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...ws, activeTabId: existing.id } } };
      const tab: ViewerTab = { id: makeTabId(), rel, pinned: true, missing: false, diff: true };
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { tabs: [...ws.tabs, tab], activeTabId: tab.id } } };
    });
  },

  clearReveal: (workspaceId, tabId) => {
    set((s) => {
      const ws = s.byWorkspace[workspaceId];
      if (!ws) return {};
      const tabs = ws.tabs.map((t) => (t.id === tabId && t.revealTarget ? { ...t, revealTarget: null } : t));
      if (tabs === ws.tabs) return {};
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...ws, tabs } } };
    });
  },

  activate: (workspaceId, tabId) => {
    set((s) => {
      const ws = s.byWorkspace[workspaceId];
      if (!ws || !ws.tabs.some((t) => t.id === tabId) || ws.activeTabId === tabId) return {};
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...ws, activeTabId: tabId } } };
    });
    schedulePersist(get().byWorkspace);
  },

  closeTab: (workspaceId, tabId) => {
    removeTab(set, workspaceId, tabId);
    schedulePersist(get().byWorkspace);
  },

  pin: (workspaceId, tabId) => {
    set((s) => {
      const ws = s.byWorkspace[workspaceId];
      if (!ws) return {};
      const tabs = ws.tabs.map((t) => (t.id === tabId && !t.pinned ? { ...t, pinned: true } : t));
      if (tabs === ws.tabs) return {};
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...ws, tabs } } };
    });
    schedulePersist(get().byWorkspace);
  },

  setMode: (workspaceId, tabId, mode) => {
    set((s) => {
      const ws = s.byWorkspace[workspaceId];
      if (!ws) return {};
      const tabs = ws.tabs.map((t) => (t.id === tabId ? { ...t, mode } : t));
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...ws, tabs } } };
    });
    schedulePersist(get().byWorkspace);
  },

  retarget: (workspaceId, oldRel, newRel) => {
    let changed = false;
    set((s) => {
      const ws = s.byWorkspace[workspaceId];
      if (!ws) return {};
      const tabs = ws.tabs.map((t) => {
        if (!isSameOrDescendant(t.rel, oldRel)) return t;
        changed = true;
        return { ...t, rel: newRel + t.rel.slice(oldRel.length) };
      });
      if (!changed) return {};
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...ws, tabs } } };
    });
    if (changed) {
      rekeyDocsForRetarget(workspaceId, oldRel, newRel);
      schedulePersist(get().byWorkspace);
    }
  },
}));
