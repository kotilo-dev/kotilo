/**
 * Workspaces + dosya ağacı state'i (faz2-spec §6, §8). Tek doğruluk kaynağı backend'dir:
 * `workspaces`/`activeId` yalnızca `workspace_list()` (açılış) ve `workspaces:changed`
 * event'i ile güncellenir — optimistic update yok. `dirCache` ve `expanded` ise saf
 * frontend UI durumudur (backend yalnızca `expandedDirs`'i kalıcı yazar, kaynak değildir).
 */
import { create } from "zustand";
import { batchFsChanges } from "../lib/fsBatch";
import {
  type AppError,
  type DirEntry,
  type QuickOpenItem,
  type Workspace,
  type WorkspaceGroup,
  type WorkspacesState,
  clipboardSaveImage,
  clipboardWriteText,
  fsCreateDir,
  fsCreateFile,
  fsDelete,
  fsQuickOpen,
  fsReadDir,
  fsRename,
  fsReveal,
  onFsChanged,
  onFsRescan,
  onWorkspacesChanged,
  toAppError,
  workspaceAdd,
  workspaceGroupCreate,
  workspaceGroupMove,
  workspaceGroupRemove,
  workspaceGroupRename,
  workspaceList,
  workspaceRemove,
  workspaceRename,
  workspaceReorder,
  workspaceSetActive,
  workspaceSetExpanded,
  workspaceSetGroup,
} from "../lib/ipc";
import { groupNeighbour } from "../features/workspaces/groups";
import { useSettingsStore } from "./settingsStore";
import type { DirState } from "../features/workspaces/flatten";
import {
  absolutePath,
  ancestorsOf,
  depthOf,
  isSameOrDescendant,
  parentRel,
  pruneRecordPrefix,
  pruneSetPrefix,
  rekeyRecordPrefix,
  rekeySetPrefix,
} from "../features/workspaces/paths";
import { useToastStore } from "./toastStore";
import { useViewerStore } from "./viewerStore";
import { strings } from "../app/strings";

export type { DirState };

export interface Selected {
  workspaceId: string;
  rel: string;
}

interface WorkspaceStore {
  ready: boolean;
  workspaces: Workspace[];
  activeId: string | null;
  /** D-080: user groups in display order. */
  groups: WorkspaceGroup[];
  dirCache: Record<string, Record<string, DirState>>;
  expanded: Record<string, Set<string>>;
  selected: Selected | null;

  init: () => Promise<void>;

  addWorkspace: (path: string, opts?: { silentIfNotDirectory?: boolean }) => Promise<void>;
  removeWorkspace: (id: string) => Promise<void>;
  renameWorkspace: (id: string, name: string) => Promise<AppError | null>;
  setActive: (id: string) => Promise<void>;
  /** Swaps with the neighbour in the same group section (D-080). */
  moveWorkspace: (id: string, direction: "up" | "down") => Promise<void>;
  /** D-080 groups; the name-taking ones return the error for the inline input. */
  createGroup: (name: string, workspaceId?: string) => Promise<AppError | null>;
  renameGroup: (id: string, name: string) => Promise<AppError | null>;
  removeGroup: (id: string) => Promise<void>;
  moveGroup: (id: string, direction: "up" | "down") => Promise<void>;
  setWorkspaceGroup: (workspaceId: string, groupId: string | null) => Promise<void>;

  toggleExpanded: (workspaceId: string, rel: string) => void;
  /** The Files tab always shows the active workspace's top level: make sure it is loaded. */
  ensureRootLoaded: (workspaceId: string) => Promise<void>;
  expandAncestors: (workspaceId: string, rel: string) => Promise<void>;
  select: (workspaceId: string, rel: string) => void;

  createFile: (workspaceId: string, dirRel: string, name: string) => Promise<AppError | null>;
  createDir: (workspaceId: string, dirRel: string, name: string) => Promise<AppError | null>;
  renameEntry: (workspaceId: string, rel: string, newName: string) => Promise<AppError | null>;
  deleteEntry: (workspaceId: string, rel: string) => Promise<void>;
  reveal: (workspaceId: string, rel: string) => Promise<void>;
  /** Faz 6 §3/§4: `fs_search` yerine `fs_quick_open` (nucleo-matcher) — WorkspacesPanel filtresi de bunu kullanır. */
  search: (workspaceId: string, query: string, limit: number) => Promise<QuickOpenItem[]>;
  saveClipboardImage: (workspaceId: string, dirRel: string) => Promise<void>;
  copyPath: (workspaceId: string, rel: string) => Promise<void>;
  copyRelativePath: (workspaceId: string, rel: string) => Promise<void>;
}

// Zustand state'inin bir parçası değil (gereksiz re-render'a yol açmasın diye) — layoutStore'daki
// `saveTimer` deseniyle aynı: her workspace için ayrı debounce zamanlayıcısı.
const expandedSaveTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const EXPANDED_SAVE_DEBOUNCE_MS = 300;

function scheduleExpandedSave(workspaceId: string, dirs: string[]) {
  const existing = expandedSaveTimers[workspaceId];
  if (existing) clearTimeout(existing);
  expandedSaveTimers[workspaceId] = setTimeout(() => {
    delete expandedSaveTimers[workspaceId];
    void workspaceSetExpanded(workspaceId, dirs);
  }, EXPANDED_SAVE_DEBOUNCE_MS);
}

function cancelExpandedSave(workspaceId: string) {
  const existing = expandedSaveTimers[workspaceId];
  if (existing) {
    clearTimeout(existing);
    delete expandedSaveTimers[workspaceId];
  }
}

let listenersInstalled = false;

/** Runs a group command; the state arrives with `workspaces:changed`. `toast` = report failures here (no inline input to show them). */
async function groupCall(run: () => Promise<void>, toast = false): Promise<AppError | null> {
  try {
    await run();
    return null;
  } catch (e) {
    if (toast) useToastStore.getState().show(strings.toast.genericError);
    return toAppError(e);
  }
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  ready: false,
  workspaces: [],
  activeId: null,
  groups: [],
  dirCache: {},
  expanded: {},
  selected: null,

  init: async () => {
    if (!listenersInstalled) {
      listenersInstalled = true;
      void onFsChanged(
        batchFsChanges(({ workspaceId, dirs }) => {
          for (const dir of dirs) void reloadDir(get, set, workspaceId, dir);
        }),
      );
      void onFsRescan(({ workspaceId }) => {
        const cache = get().dirCache[workspaceId] ?? {};
        for (const rel of Object.keys(cache)) void reloadDir(get, set, workspaceId, rel);
      });
      void onWorkspacesChanged((next) => applyWorkspacesChanged(get, set, next));
      // faz6-spec §1.4: gizleme kalıpları/`.gitignore` uyumu değişince açık (cache'teki) tüm
      // dizinler backend'in yeni kurallarıyla yeniden okunur (`fs_read_dir` yeni ayarları uygular).
      // Değer karşılaştırması (referans değil, bkz. App.tsx'teki aynı not): backend'den dönen
      // her `settings_set` yanıtı IPC üzerinden yeniden serileştirildiği
      // için ilgisiz bir alan (ör. tema) değişince bile `hiddenPatterns` yeni bir dizi referansı
      // taşıyabilir — bu, tema değişince tüm ağaçların gereksiz yere yeniden okunmasını engeller.
      // Optimistik `settings` değil backend-onaylı `confirmed` izlenir: `fs_read_dir` backend'in
      // ayarlarını kullanır, yazım bitmeden yeniden okumak bir adım eski sonuç verir.
      useSettingsStore.subscribe((state, prev) => {
        const nextPatterns = state.confirmed.files.hiddenPatterns;
        const prevPatterns = prev.confirmed.files.hiddenPatterns;
        const patternsChanged =
          nextPatterns.length !== prevPatterns.length || nextPatterns.some((p, i) => p !== prevPatterns[i]);
        const filesChanged = state.confirmed.files.respectGitignore !== prev.confirmed.files.respectGitignore || patternsChanged;
        if (!filesChanged) return;
        for (const [workspaceId, cache] of Object.entries(get().dirCache)) {
          for (const rel of Object.keys(cache)) void reloadDir(get, set, workspaceId, rel);
        }
      });
    }

    try {
      const state = await workspaceList();
      set({ workspaces: state.workspaces, activeId: state.activeId, groups: state.groups ?? [], ready: true });
      await Promise.all(state.workspaces.map((ws) => restoreExpanded(get, set, ws)));
    } catch {
      set({ workspaces: [], activeId: null, groups: [], ready: true });
    }
  },

  addWorkspace: async (path, opts) => {
    try {
      await workspaceAdd(path);
    } catch (e) {
      const err = toAppError(e);
      if (err.code === "duplicate_workspace") useToastStore.getState().show(strings.toast.duplicateWorkspace);
      else if (err.code === "not_a_directory") {
        // Sürükle-bırak: klasör olmayan yollar sessizce atlanır (faz2-spec §6).
        if (!opts?.silentIfNotDirectory) useToastStore.getState().show(strings.toast.notADirectory);
      } else useToastStore.getState().show(strings.toast.genericError);
    }
  },

  removeWorkspace: async (id) => {
    cancelExpandedSave(id);
    try {
      await workspaceRemove(id);
    } catch {
      useToastStore.getState().show(strings.toast.genericError);
    }
  },

  renameWorkspace: async (id, name) => {
    try {
      await workspaceRename(id, name);
      return null;
    } catch (e) {
      return toAppError(e);
    }
  },

  setActive: async (id) => {
    try {
      await workspaceSetActive(id);
    } catch {
      useToastStore.getState().show(strings.toast.genericError);
    }
  },

  moveWorkspace: async (id, direction) => {
    const { workspaces, groups } = get();
    const other = groupNeighbour(workspaces, groups, id, direction);
    if (!other) return;
    const ids = workspaces.map((w) => w.id);
    const a = ids.indexOf(id);
    const b = ids.indexOf(other);
    [ids[a], ids[b]] = [ids[b]!, ids[a]!];
    try {
      await workspaceReorder(ids);
    } catch {
      useToastStore.getState().show(strings.toast.genericError);
    }
  },

  createGroup: (name, workspaceId) => groupCall(() => workspaceGroupCreate(name, workspaceId)),
  renameGroup: (id, name) => groupCall(() => workspaceGroupRename(id, name)),
  removeGroup: async (id) => void (await groupCall(() => workspaceGroupRemove(id), true)),
  moveGroup: async (id, direction) => void (await groupCall(() => workspaceGroupMove(id, direction), true)),
  setWorkspaceGroup: async (workspaceId, groupId) => void (await groupCall(() => workspaceSetGroup(workspaceId, groupId), true)),

  toggleExpanded: (workspaceId, rel) => {
    const current = get().expanded[workspaceId] ?? new Set<string>();
    const next = new Set(current);
    const opening = !next.has(rel);
    if (opening) {
      next.add(rel);
    } else {
      next.delete(rel);
    }
    set((s) => ({ expanded: { ...s.expanded, [workspaceId]: next } }));
    scheduleExpandedSave(workspaceId, [...next]);
    if (opening) void ensureLoaded(get, set, workspaceId, rel);
  },

  ensureRootLoaded: (workspaceId) => ensureLoaded(get, set, workspaceId, ""),

  expandAncestors: async (workspaceId, rel) => {
    const ancestors = ancestorsOf(rel); // kökten başlar (parent-first)
    const current = get().expanded[workspaceId] ?? new Set<string>();
    const next = new Set(current);
    let changed = false;
    for (const ancestor of ancestors) {
      if (!next.has(ancestor)) {
        next.add(ancestor);
        changed = true;
      }
      await ensureLoaded(get, set, workspaceId, ancestor);
    }
    if (changed) {
      set((s) => ({ expanded: { ...s.expanded, [workspaceId]: next } }));
      scheduleExpandedSave(workspaceId, [...next]);
    }
  },

  select: (workspaceId, rel) => {
    set({ selected: { workspaceId, rel } });
  },

  createFile: async (workspaceId, dirRel, name) => {
    try {
      const rel = await fsCreateFile(workspaceId, dirRel, name);
      await reloadDir(get, set, workspaceId, dirRel);
      get().select(workspaceId, rel);
      return null;
    } catch (e) {
      return toAppError(e);
    }
  },

  createDir: async (workspaceId, dirRel, name) => {
    try {
      const rel = await fsCreateDir(workspaceId, dirRel, name);
      await reloadDir(get, set, workspaceId, dirRel);
      get().select(workspaceId, rel);
      return null;
    } catch (e) {
      return toAppError(e);
    }
  },

  renameEntry: async (workspaceId, rel, newName) => {
    try {
      const newRel = await fsRename(workspaceId, rel, newName);
      rekeyLocalState(set, workspaceId, rel, newRel);
      // faz3-spec §5.8: kendi rename'imiz viewer sekmelerini kapatmaz — sekmeleri (ve açık
      // belge anahtarlarını) yeni rel'e taşır.
      useViewerStore.getState().retarget(workspaceId, rel, newRel);
      await reloadDir(get, set, workspaceId, parentRel(rel));
      get().select(workspaceId, newRel);
      return null;
    } catch (e) {
      return toAppError(e);
    }
  },

  deleteEntry: async (workspaceId, rel) => {
    try {
      await fsDelete(workspaceId, rel);
      pruneLocalState(set, workspaceId, rel);
      const parent = parentRel(rel);
      await reloadDir(get, set, workspaceId, parent);
      const selected = get().selected;
      if (selected && selected.workspaceId === workspaceId && isSameOrDescendant(selected.rel, rel)) {
        set({ selected: null });
      }
    } catch {
      useToastStore.getState().show(strings.toast.genericError);
    }
  },

  reveal: async (workspaceId, rel) => {
    try {
      await fsReveal(workspaceId, rel);
    } catch {
      useToastStore.getState().show(strings.toast.genericError);
    }
  },

  search: async (workspaceId, query, limit) => {
    try {
      const result = await fsQuickOpen(workspaceId, query, limit);
      return result.items;
    } catch {
      return [];
    }
  },

  saveClipboardImage: async (workspaceId, dirRel) => {
    try {
      const rel = await clipboardSaveImage(workspaceId, dirRel);
      // Kayıttan hemen sonra tam yol panoya (kullanıcı isteği 2026-09-27, faz6-spec §1.3:
      // `clipboard.copyPathAfterImageSave` ayarına uyar): agent'a yapıştırıldığında terminalin
      // cwd'sinden bağımsız çalışsın. Ağaç güncellemesinden önce — kullanıcı hemen agent'a geçebilir.
      const ws = get().workspaces.find((w) => w.id === workspaceId);
      const copyPathEnabled = useSettingsStore.getState().settings.clipboard.copyPathAfterImageSave;
      let copyStatus: "copied" | "failed" | "disabled" = "disabled";
      if (copyPathEnabled) {
        try {
          await clipboardWriteText(ws ? absolutePath(ws, rel) : rel);
          copyStatus = "copied";
        } catch {
          copyStatus = "failed"; // dosya kaydedildi; toast bunu dürüstçe söyler
        }
      }
      await get().expandAncestors(workspaceId, rel);
      await reloadDir(get, set, workspaceId, dirRel);
      get().select(workspaceId, rel);
      useToastStore.getState().show(strings.toast.imageSaved(rel, copyStatus));
    } catch (e) {
      const err = toAppError(e);
      if (err.code === "no_image") useToastStore.getState().show(strings.toast.noImage);
      else useToastStore.getState().show(strings.toast.genericError);
    }
  },

  copyPath: async (workspaceId, rel) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    try {
      await clipboardWriteText(absolutePath(ws, rel));
    } catch {
      useToastStore.getState().show(strings.toast.genericError);
    }
  },

  copyRelativePath: async (_workspaceId, rel) => {
    try {
      await clipboardWriteText(rel);
    } catch {
      useToastStore.getState().show(strings.toast.genericError);
    }
  },
}));

// --- Yardımcılar (store closure'ının dışında, `get`/`set`'i parametre olarak alır) -----------

type Getter = () => WorkspaceStore;
type Setter = (
  partial: Partial<WorkspaceStore> | ((s: WorkspaceStore) => Partial<WorkspaceStore>),
) => void;

function setDirState(set: Setter, workspaceId: string, rel: string, state: DirState) {
  set((s) => ({
    dirCache: {
      ...s.dirCache,
      [workspaceId]: { ...(s.dirCache[workspaceId] ?? {}), [rel]: state },
    },
  }));
}

async function ensureLoaded(get: Getter, set: Setter, workspaceId: string, rel: string): Promise<void> {
  const existing = get().dirCache[workspaceId]?.[rel];
  if (Array.isArray(existing) || existing === "loading") return;
  setDirState(set, workspaceId, rel, "loading");
  try {
    const entries = await fsReadDir(workspaceId, rel);
    setDirState(set, workspaceId, rel, entries);
  } catch (e) {
    setDirState(set, workspaceId, rel, { error: toAppError(e) });
  }
}

/** Zaten cache'te olan bir klasörü zorla yeniden okur (create/rename/delete sonrası). */
async function reloadDir(get: Getter, set: Setter, workspaceId: string, rel: string): Promise<void> {
  const cache = get().dirCache[workspaceId];
  const before = cache?.[rel];
  if (before === undefined) return; // yalnızca cache'inde olan klasörler yeniden okunur (faz2-spec §6)
  const beforeEntries: DirEntry[] = Array.isArray(before) ? before : [];
  try {
    const entries = await fsReadDir(workspaceId, rel);
    // 0.3.2: an unchanged listing keeps its array, so the tree does not re-render.
    const current = get().dirCache[workspaceId]?.[rel];
    if (Array.isArray(current) && sameEntries(current, entries)) return;
    setDirState(set, workspaceId, rel, entries);
    // §8.17: artık listede olmayan alt klasörlerin dirCache/expanded/selected girdileri (prefix ile) temizlenir.
    const newDirRels = new Set(entries.filter((e) => e.isDir).map((e) => e.rel));
    for (const old of beforeEntries) {
      if (old.isDir && !newDirRels.has(old.rel)) {
        pruneLocalState(set, workspaceId, old.rel);
      }
    }
  } catch (e) {
    setDirState(set, workspaceId, rel, { error: toAppError(e) });
  }
}

function sameEntries(a: DirEntry[], b: DirEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => e.name === b[i]!.name && e.rel === b[i]!.rel && e.isDir === b[i]!.isDir);
}

function pruneLocalState(set: Setter, workspaceId: string, rel: string) {
  set((s) => {
    const wsCache = s.dirCache[workspaceId];
    const wsExpanded = s.expanded[workspaceId];
    const dirCache = wsCache ? { ...s.dirCache, [workspaceId]: pruneRecordPrefix(wsCache, rel) } : s.dirCache;
    const expanded = wsExpanded ? { ...s.expanded, [workspaceId]: pruneSetPrefix(wsExpanded, rel) } : s.expanded;
    const selected =
      s.selected && s.selected.workspaceId === workspaceId && isSameOrDescendant(s.selected.rel, rel)
        ? null
        : s.selected;
    return { dirCache, expanded, selected };
  });
}

function rekeyLocalState(set: Setter, workspaceId: string, oldRel: string, newRel: string) {
  set((s) => {
    const wsCache = s.dirCache[workspaceId];
    const wsExpanded = s.expanded[workspaceId];
    const dirCache = wsCache ? { ...s.dirCache, [workspaceId]: rekeyRecordPrefix(wsCache, oldRel, newRel) } : s.dirCache;
    const expanded = wsExpanded ? { ...s.expanded, [workspaceId]: rekeySetPrefix(wsExpanded, oldRel, newRel) } : s.expanded;
    const selected =
      s.selected && s.selected.workspaceId === workspaceId && isSameOrDescendant(s.selected.rel, oldRel)
        ? { workspaceId, rel: newRel + s.selected.rel.slice(oldRel.length) }
        : s.selected;
    return { dirCache, expanded, selected };
  });
}

/** Açılışta kayıtlı `expandedDirs`'i ebeveyn-önce yükler; `not_found` sessizce düşer (§8.18). */
async function restoreExpanded(get: Getter, set: Setter, ws: Workspace): Promise<void> {
  const sorted = [...ws.expandedDirs].sort((a, b) => depthOf(a) - depthOf(b));
  const valid = new Set<string>();
  const pruned: string[] = [];

  for (const rel of sorted) {
    if (pruned.some((p) => isSameOrDescendant(rel, p))) continue; // ebeveyni zaten düşürüldü
    setDirState(set, ws.id, rel, "loading");
    try {
      const entries = await fsReadDir(ws.id, rel);
      setDirState(set, ws.id, rel, entries);
      valid.add(rel);
    } catch {
      // not_found (veya başka bir hata) → bu klasörü sessizce expanded'dan düş; alt öğeleri de atla.
      set((s) => {
        const wsCache = s.dirCache[ws.id];
        return wsCache ? { dirCache: { ...s.dirCache, [ws.id]: pruneRecordPrefix(wsCache, rel) } } : {};
      });
      pruned.push(rel);
    }
  }

  // Uzun süren restore sırasında workspace kaldırılmış olabilir (workspaces:changed) — o durumda
  // dangling bir `expanded` anahtarı yaratmamak için hiçbir şey yazma.
  if (!get().workspaces.some((w) => w.id === ws.id)) return;
  // Finding #8: merge the restored dirs into whatever is *currently* expanded rather than
  // replacing it outright — `restoreExpanded` runs asynchronously (one `fsReadDir` await
  // per persisted dir) after `ready: true`, so the user can toggle other directories open
  // or closed in the meantime; a wholesale replace here would clobber those toggles.
  set((s) => {
    const current = s.expanded[ws.id] ?? new Set<string>();
    const merged = new Set([...current, ...valid]);
    return { expanded: { ...s.expanded, [ws.id]: merged } };
  });
}

function applyWorkspacesChanged(get: Getter, set: Setter, next: WorkspacesState): void {
  const prevActiveId = get().activeId;
  const prevIds = new Set(get().workspaces.map((w) => w.id));
  const nextIds = new Set(next.workspaces.map((w) => w.id));
  const removedIds = [...prevIds].filter((id) => !nextIds.has(id));
  const addedIds = [...nextIds].filter((id) => !prevIds.has(id));

  for (const id of removedIds) cancelExpandedSave(id);

  set((s) => {
    const dirCache = { ...s.dirCache };
    const expanded = { ...s.expanded };
    for (const id of removedIds) {
      delete dirCache[id];
      delete expanded[id];
    }
    const selected = s.selected && removedIds.includes(s.selected.workspaceId) ? null : s.selected;
    return { workspaces: next.workspaces, activeId: next.activeId, groups: next.groups ?? [], dirCache, expanded, selected };
  });

  // Aktif workspace değiştiyse (liste, geçiş listesi, "Open terminal here", Agents paneli…): Files
  // sekmesi yalnız aktifin içeriğini gösterir ve kök her zaman açıktır — kökün içeriğini yükle.
  const activeId = next.activeId;
  if (activeId && activeId !== prevActiveId && !addedIds.includes(activeId)) {
    void ensureLoaded(get, set, activeId, "");
  }

  // Yeni eklenen workspace'ler (dialog/drag-drop ile): kök varsayılan olarak açık ve yüklü.
  for (const id of addedIds) {
    set((s) => ({ expanded: { ...s.expanded, [id]: new Set([""]) } }));
    void ensureLoaded(get, set, id, "");
    // Finding #12: persist this default-expanded root too, otherwise it's back to
    // collapsed after a restart (nothing ever scheduled a save for it).
    scheduleExpandedSave(id, [""]);
  }
}

