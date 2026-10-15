/**
 * Terminal sekme yönetimi (faz4-spec §2.2, §4 revizyonu bağlayıcı). Workspace başına
 * `{ tabs, activeTabId }` — xterm örneklerinin kendisi burada değil, `terminalRegistry`'de
 * (React dışı, bkz. o dosyanın başlığı). Bu store yalnızca sekme metadata'sını ve PTY yaşam
 * döngüsünü (spawn/exit/restart/close) yönetir.
 *
 * Kalıcılık `"terminals"` state slice'ında (500ms debounce), Faz 3'ün `viewerStore`'undaki
 * desenin aynısı: `init()` yeniden giriş korumalı, `workspaces:changed` ile prune edilir.
 */
import { create } from "zustand";
import {
  appInfo,
  terminalFontSuggestion,
  loadState,
  onPtyExit,
  onWorkspacesChanged,
  ptyKill,
  ptyProfiles,
  ptySpawn,
  saveStateSlice,
  toAppError,
  workspaceList,
  type ShellKind,
  type ShellProfile,
} from "../lib/ipc";
import { strings } from "../app/strings";
import * as registry from "../features/terminal/terminalRegistry";
import { restoreSplit, splitAfterRemove } from "../features/terminal/splitLayout";
import { useLeftoverStore } from "./leftoverStore";

export type TabStatus = "idle" | "starting" | "running" | "exited";

export interface TerminalTab {
  id: string;
  title: string;
  profileId: ShellKind | null;
  cwdRel: string;
  agentCommand: string | null;
  status: TabStatus;
  exitCode?: number;
  paneId?: string;
  pid?: number;
  titleEdited: boolean;
  /** `starting` sırasında `closeTab` çağrıldı — spawn çözülünce pane hemen kill edilir (§4.7). */
  closing?: boolean;
  /**
   * Geçici (KALICI DEĞİL, `serialize()`'a hiç girmez — LOW #3): `newTerminal` ile oluşturulan
   * her sekmede (shell + agent) `true`. D21 yalnızca RESTORE edilen agent sekmelerinin otomatik
   * başlamasını yasaklar — yeni "New agent ▶" ile oluşturulanlar otomatik başlamalı. Restore
   * edilen sekmelerde bu alan yok (`undefined`).
   */
  autoStart?: boolean;
}

interface WorkspaceTerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  /** M4 split pane (§7.3): the tab shown on the right half; the left half is `activeTabId`. */
  splitTabId?: string | null;
  /** The split half that last had focus (session only, not persisted); drives the timeline rail. */
  focusedTabId?: string | null;
}

interface PersistedTab {
  title: string;
  titleEdited: boolean;
  profileId: ShellKind | null;
  cwdRel: string;
  agentCommand: string | null;
}

interface PersistedWorkspaceTerminals {
  tabs: PersistedTab[];
  activeIndex: number;
  /** M4: index of the right-half tab; absent when the panel is not split. */
  splitIndex?: number;
}

type PersistedTerminalState = Record<string, PersistedWorkspaceTerminals>;

const STATE_KEY = "terminals";
const SAVE_DEBOUNCE_MS = 500;

export interface NewTerminalOptions {
  profileId?: ShellKind | null;
  cwdRel?: string;
  agentCommand?: string | null;
}

export interface StartOptions {
  /** "Start shell only" (D21): agentCommand'ı bu spawn için görmezden gel, tab'da tutulur. */
  shellOnly?: boolean;
}

interface TerminalStore {
  ready: boolean;
  byWorkspace: Record<string, WorkspaceTerminalState>;
  profiles: ShellProfile[];

  init: () => Promise<void>;
  newTerminal: (workspaceId: string, opts?: NewTerminalOptions) => string;
  activate: (workspaceId: string, tabId: string) => void;
  rename: (workspaceId: string, tabId: string, title: string) => void;
  /** xterm `onTitleChange` — yalnızca `titleEdited===false` iken uygulanır (§2.2). */
  setAutoTitle: (workspaceId: string, tabId: string, title: string) => void;
  closeTab: (workspaceId: string, tabId: string) => Promise<void>;
  start: (workspaceId: string, tabId: string, opts?: StartOptions) => Promise<void>;
  restart: (workspaceId: string, tabId: string) => Promise<void>;
  onExit: (paneId: string, exitCode: number) => void;
  /** Kaldırma onayı metni için: o workspace'in `running|starting` sekme sayısı (§4.11). */
  runningCount: (workspaceId: string) => number;
  /** Faz 5 (agents paneli): bir `paneId`'nin şu an hangi sekmeye ait olduğu — pane bir sekmeden
   * yeniden başlatılmış (yeni paneId) olabilir, bu durumda bulunamaz (`undefined`, hata değil). */
  findTabByPaneId: (paneId: string) => { workspaceId: string; tab: TerminalTab } | undefined;
  /** M4 split pane: shows `left` (becomes active) and `right` side by side. */
  setSplit: (workspaceId: string, left: string, right: string) => void;
  /** Back to a single pane; `keep` is the half that stays (both tabs stay open). */
  closeSplit: (workspaceId: string, keep: "left" | "right") => void;
  /** Records which pane of the workspace has focus (only matters while split). */
  setFocusedTab: (workspaceId: string, tabId: string) => void;
}

let nextTabId = 1;
function makeTabId(): string {
  return `term-${nextTabId++}`;
}

/** Sekme çıktı bilgisi için `starting`/spawn çözülmeden gelen `pty:exit`ler (§4.7). */
const earlyExits = new Map<string, number>();

/**
 * `ptyKill` ile bilerek öldürülen (sekme zaten kaldırılmış/kaldırılacak) pane'lerin id'leri —
 * bunlar için gelecek `pty:exit` hiçbir sekmeyle eşleşmeyecek ve aksi halde sonsuza dek
 * `earlyExits`'te birikirdi (LOW #6). Eşleşen olay gelince tüketilir (`delete`); olay hiç
 * gelmezse (beklenmez ama savunma amaçlı) boyut sınırlanır.
 */
const killedPanes = new Set<string>();
const KILLED_PANES_LIMIT = 200;

function markPaneKilled(paneId: string | undefined): void {
  if (!paneId) return;
  killedPanes.add(paneId);
  if (killedPanes.size > KILLED_PANES_LIMIT) {
    const oldest = killedPanes.values().next().value;
    if (oldest !== undefined) killedPanes.delete(oldest);
  }
}

function profileNameFor(profiles: ShellProfile[], profileId: ShellKind | null): string {
  if (profileId) {
    const found = profiles.find((p) => p.id === profileId);
    if (found) return found.name;
  }
  return profiles[0]?.name ?? "Terminal";
}

function defaultTitleFor(profiles: ShellProfile[], profileId: ShellKind | null, agentCommand: string | null): string {
  return agentCommand ?? profileNameFor(profiles, profileId);
}

function serialize(byWorkspace: Record<string, WorkspaceTerminalState>): PersistedTerminalState {
  const out: PersistedTerminalState = {};
  for (const [workspaceId, ws] of Object.entries(byWorkspace)) {
    const activeIndex = Math.max(0, ws.tabs.findIndex((t) => t.id === ws.activeTabId));
    const splitIndex = ws.splitTabId ? ws.tabs.findIndex((t) => t.id === ws.splitTabId) : -1;
    out[workspaceId] = {
      tabs: ws.tabs.map((t) => ({
        title: t.title,
        titleEdited: t.titleEdited,
        profileId: t.profileId,
        cwdRel: t.cwdRel,
        agentCommand: t.agentCommand,
      })),
      activeIndex,
      ...(splitIndex >= 0 && splitIndex !== activeIndex ? { splitIndex } : {}),
    };
  }
  return out;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePersist(byWorkspace: Record<string, WorkspaceTerminalState>): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    // Fire-and-forget: `saveStateSlice`'s `invoke` wrapper already logs a failure
    // (faz7-spec §9.5); `.catch` here only silences the resulting unhandled rejection.
    void saveStateSlice(STATE_KEY, serialize(byWorkspace)).catch(() => {});
  }, SAVE_DEBOUNCE_MS);
}

type Getter = () => TerminalStore;
type Setter = (partial: Partial<TerminalStore> | ((s: TerminalStore) => Partial<TerminalStore>)) => void;

function findTab(get: Getter, workspaceId: string, tabId: string): TerminalTab | undefined {
  return get().byWorkspace[workspaceId]?.tabs.find((t) => t.id === tabId);
}

/**
 * Saf arama (bir `byWorkspace` anlık görüntüsü üzerinde) — Faz 5 (agents paneli) reaktif bir
 * selector içinde de kullanabilsin diye `get()`'e bağlı değil; store'daki `findTabByPaneId`
 * bunu sarmalar.
 */
export function findTabByPaneIdInMap(
  byWorkspace: Record<string, WorkspaceTerminalState>,
  paneId: string,
): { workspaceId: string; tab: TerminalTab } | undefined {
  for (const [workspaceId, ws] of Object.entries(byWorkspace)) {
    const tab = ws.tabs.find((t) => t.paneId === paneId);
    if (tab) return { workspaceId, tab };
  }
  return undefined;
}

function findTabByPaneId(get: Getter, paneId: string): { workspaceId: string; tab: TerminalTab } | undefined {
  return findTabByPaneIdInMap(get().byWorkspace, paneId);
}

function updateTab(set: Setter, workspaceId: string, tabId: string, patch: Partial<TerminalTab>): void {
  set((s) => {
    const ws = s.byWorkspace[workspaceId];
    if (!ws) return {};
    const tabs = ws.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t));
    return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...ws, tabs } } };
  });
}

function removeTabFromState(set: Setter, workspaceId: string, tabId: string): void {
  set((s) => {
    const ws = s.byWorkspace[workspaceId];
    if (!ws) return {};
    const idx = ws.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return {};
    const tabs = ws.tabs.filter((t) => t.id !== tabId);
    // M4: closing either half of a split returns to a single pane.
    const unsplit = splitAfterRemove(ws.activeTabId, ws.splitTabId ?? null, tabId);
    if (unsplit) return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { tabs, ...unsplit } } };
    let activeTabId = ws.activeTabId;
    if (activeTabId === tabId) {
      const neighbor = tabs[idx] ?? tabs[idx - 1];
      activeTabId = neighbor?.id ?? null;
    }
    return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...ws, tabs, activeTabId } } };
  });
}

/** Sekme "düz shell" mi (agent komutu yok) — çıkış 0 otomatik kapanma kuralı için (§2.2). */
function isPlainShellTab(tab: TerminalTab): boolean {
  return tab.agentCommand === null;
}

function applyExit(set: Setter, get: Getter, workspaceId: string, tabId: string, exitCode: number): void {
  const tab = findTab(get, workspaceId, tabId);
  // Kullanıcının `closeTab`'ından sonra gelen bir `pty:exit` için sekme zaten yok — no-op (§4.7).
  if (!tab) return;
  if (tab.paneId) useLeftoverStore.getState().clear(tab.paneId);

  if (isPlainShellTab(tab) && exitCode === 0) {
    registry.disposeTerminal(tabId);
    removeTabFromState(set, workspaceId, tabId);
    schedulePersist(get().byWorkspace);
    return;
  }

  updateTab(set, workspaceId, tabId, { status: "exited", exitCode, paneId: undefined });
  registry.writeInfoLine(tabId, strings.terminal.exitedWithCode(exitCode));
}

let listenersInstalled = false;
function installListeners(get: Getter, set: Setter): void {
  if (listenersInstalled) return;
  listenersInstalled = true;

  void onPtyExit(({ paneId, exitCode }) => {
    if (killedPanes.delete(paneId)) return; // bilerek öldürüldü — sekme zaten gitti, yok say
    const found = findTabByPaneId(get, paneId);
    if (!found) {
      earlyExits.set(paneId, exitCode);
      return;
    }
    applyExit(set, get, found.workspaceId, found.tab.id, exitCode);
  });

  void onWorkspacesChanged((next) => {
    const validIds = new Set(next.workspaces.map((w) => w.id));
    const removedIds = Object.keys(get().byWorkspace).filter((id) => !validIds.has(id));
    if (removedIds.length === 0) return;

    for (const workspaceId of removedIds) {
      const ws = get().byWorkspace[workspaceId];
      for (const tab of ws?.tabs ?? []) {
        registry.disposeTerminal(tab.id);
        if (tab.paneId) {
          markPaneKilled(tab.paneId);
          void ptyKill(tab.paneId).catch(() => {});
        }
      }
    }

    set((s) => {
      const byWorkspace = { ...s.byWorkspace };
      for (const id of removedIds) delete byWorkspace[id];
      return { byWorkspace };
    });
  });
}

let initPromise: Promise<void> | null = null;

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  ready: false,
  byWorkspace: {},
  profiles: [],

  init: () => {
    if (get().ready) return Promise.resolve();
    if (initPromise) return initPromise;

    initPromise = (async () => {
      let persisted: PersistedTerminalState = {};
      try {
        const raw = await loadState();
        const rawTerminals = raw[STATE_KEY];
        if (rawTerminals && typeof rawTerminals === "object") persisted = rawTerminals as PersistedTerminalState;
      } catch {
        persisted = {};
      }

      let profiles: ShellProfile[] = [];
      try {
        profiles = await ptyProfiles();
      } catch {
        profiles = [];
      }

      // LOW #8c: build number, sekmeler (hatta restore edilenler) `terminalRegistry`'de bir
      // `Terminal` örneğine dönüşmeden ÖNCE okunmalı — `defaultCreateTerminal()` bunu yalnızca
      // oluşturma anında okur, sonradan `setWindowsPtyBuildNumber` çağırmak halihazırda
      // oluşturulmuş bir örneği güncellemez. Başarısızsa sessizce atlanır (conpty'siz devam).
      try {
        const info = await appInfo();
        registry.setWindowsPtyBuildNumber(info.osBuild);
      } catch {
        // yut — build number olmadan devam (conpty resize/imleç sezgileri devreye girmez)
      }
      // D-055: like the build number, read before the first terminal is created.
      try {
        registry.setTerminalFontSuggestion(await terminalFontSuggestion());
      } catch {
        // no suggestion: the default font stays as it is
      }

      let validWorkspaceIds: Set<string>;
      try {
        const wsState = await workspaceList();
        validWorkspaceIds = new Set(wsState.workspaces.map((w) => w.id));
      } catch {
        validWorkspaceIds = new Set(Object.keys(persisted));
      }

      const byWorkspace: Record<string, WorkspaceTerminalState> = {};
      for (const [workspaceId, entry] of Object.entries(persisted)) {
        if (!validWorkspaceIds.has(workspaceId)) continue;
        const tabs: TerminalTab[] = (entry.tabs ?? []).map((t) => ({
          id: makeTabId(),
          // §4.12: geri yüklemede title yalnızca titleEdited ise kaydedilen; aksi halde
          // profil adı/agent komutundan yeniden türetilir (OSC başlığı yeniden türetilmez).
          title: t.titleEdited ? t.title : defaultTitleFor(profiles, t.profileId, t.agentCommand),
          profileId: t.profileId,
          cwdRel: t.cwdRel,
          agentCommand: t.agentCommand,
          status: "idle",
          titleEdited: t.titleEdited,
        }));
        if (tabs.length === 0) continue;
        const active = tabs[entry.activeIndex] ?? tabs[tabs.length - 1]!;
        const splitId = restoreSplit(tabs.map((t) => t.id), tabs.indexOf(active), entry.splitIndex);
        byWorkspace[workspaceId] = splitId ? { tabs, activeTabId: active.id, splitTabId: splitId } : { tabs, activeTabId: active.id };
      }

      set({ byWorkspace, profiles, ready: true });
      installListeners(get, set);
    })().finally(() => {
      initPromise = null;
    });

    return initPromise;
  },

  newTerminal: (workspaceId, opts) => {
    const id = makeTabId();
    const profileId = opts?.profileId ?? null;
    const cwdRel = opts?.cwdRel ?? "";
    const agentCommand = opts?.agentCommand ?? null;
    const tab: TerminalTab = {
      id,
      title: defaultTitleFor(get().profiles, profileId, agentCommand),
      profileId,
      cwdRel,
      agentCommand,
      status: "idle",
      titleEdited: false,
      autoStart: true, // LOW #3: yeni oluşturulan sekme (shell veya agent) — restore'da yok
    };
    set((s) => {
      const ws = s.byWorkspace[workspaceId] ?? { tabs: [], activeTabId: null };
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...ws, tabs: [...ws.tabs, tab], activeTabId: id } } };
    });
    schedulePersist(get().byWorkspace);
    return id;
  },

  activate: (workspaceId, tabId) => {
    set((s) => {
      const ws = s.byWorkspace[workspaceId];
      // M4: the right half's tab is already visible – activating it keeps the split as it is.
      if (!ws || !ws.tabs.some((t) => t.id === tabId) || ws.activeTabId === tabId || ws.splitTabId === tabId) return {};
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...ws, activeTabId: tabId } } };
    });
    schedulePersist(get().byWorkspace);
  },

  rename: (workspaceId, tabId, title) => {
    if (title.trim() === "") return;
    updateTab(set, workspaceId, tabId, { title, titleEdited: true });
    schedulePersist(get().byWorkspace);
  },

  setAutoTitle: (workspaceId, tabId, title) => {
    const tab = findTab(get, workspaceId, tabId);
    if (!tab || tab.titleEdited) return;
    updateTab(set, workspaceId, tabId, { title });
  },

  closeTab: async (workspaceId, tabId) => {
    const tab = findTab(get, workspaceId, tabId);
    if (!tab) return;

    if (tab.status === "starting") {
      // Spawn çözülünce pane hemen kill edilir (§4.7) — burada sekmeyi kaldırmıyoruz, aksi
      // halde `start()` çözüldüğünde artık var olmayan bir sekmeye yazmaya çalışır.
      updateTab(set, workspaceId, tabId, { closing: true });
      return;
    }

    const paneId = tab.paneId;
    if (paneId) useLeftoverStore.getState().clear(paneId);
    registry.disposeTerminal(tabId);
    removeTabFromState(set, workspaceId, tabId);
    schedulePersist(get().byWorkspace);
    if (paneId) {
      markPaneKilled(paneId);
      await ptyKill(paneId).catch(() => {});
    }
  },

  start: async (workspaceId, tabId, opts) => {
    const tab = findTab(get, workspaceId, tabId);
    if (!tab) return;
    if (tab.status === "starting" || tab.status === "running") return; // idempotent (§2.2)

    // MEDIUM #5: `closing` burada TEMİZLENMEZ. `start()` bu retry (aşağıda, hatalı cwd
    // sonrası) ile kendini yeniden çağırabilir; o çağrıda `closing` zaten `true` olabilir
    // (kullanıcı ilk deneme sürerken sekmeyi kapattı) — burada `false`'a sıfırlarsak kapanış
    // isteği kaybolur ve retry, kullanıcının kapatmak istediği bir sekme için spawn'a devam eder.
    updateTab(set, workspaceId, tabId, { status: "starting" });
    const entry = registry.getOrCreateEntry(tabId);
    registry.dropChannel(tabId);
    const channel = registry.getChannel(tabId);

    const agentCommand = opts?.shellOnly ? null : tab.agentCommand;
    try {
      const { paneId, pid } = await ptySpawn({
        workspaceId,
        cwdRel: tab.cwdRel,
        profileId: tab.profileId,
        agentCommand,
        cols: entry.term.cols || 80,
        rows: entry.term.rows || 24,
        onData: channel,
      });
      entry.paneId = paneId;

      const latest = findTab(get, workspaceId, tabId);
      if (!latest) {
        // Workspace prune sırasında sekme kaldırılmış olabilir — pane'i öksüz bırakma.
        markPaneKilled(paneId);
        await ptyKill(paneId).catch(() => {});
        return;
      }
      if (latest.closing) {
        markPaneKilled(paneId);
        await ptyKill(paneId).catch(() => {});
        registry.disposeTerminal(tabId);
        removeTabFromState(set, workspaceId, tabId);
        schedulePersist(get().byWorkspace);
        return;
      }

      const earlyCode = earlyExits.get(paneId);
      if (earlyCode !== undefined) {
        earlyExits.delete(paneId);
        updateTab(set, workspaceId, tabId, { status: "running", paneId, pid });
        applyExit(set, get, workspaceId, tabId, earlyCode);
        return;
      }

      updateTab(set, workspaceId, tabId, { status: "running", paneId, pid });
    } catch (e) {
      // MEDIUM #5: spawn başarısız oldu (hiçbir pane yok, kill edilecek bir şey yok) — ama
      // kullanıcı bu arada sekmeyi kapatmış olabilir (`closeTab` "starting" iken `closing:true`
      // yazar). En güncel durumu oku: kapanıyorsa retry'a girme, sekmeyi sil ve çık.
      const latest = findTab(get, workspaceId, tabId);
      if (!latest) return; // sekme zaten (prune ile) kaldırılmış
      if (latest.closing) {
        registry.disposeTerminal(tabId);
        removeTabFromState(set, workspaceId, tabId);
        schedulePersist(get().byWorkspace);
        return;
      }

      const err = toAppError(e);
      if ((err.code === "not_found" || err.code === "not_a_directory") && latest.cwdRel !== "") {
        // §4.10: geçersiz cwd → workspace köküyle yeniden dene, tek satır bilgi yaz.
        registry.writeInfoLine(tabId, strings.terminal.cwdNotFoundNotice(latest.cwdRel));
        updateTab(set, workspaceId, tabId, { status: "idle", cwdRel: "" });
        schedulePersist(get().byWorkspace);
        return get().start(workspaceId, tabId, opts);
      }
      updateTab(set, workspaceId, tabId, { status: "exited", exitCode: -1 });
      registry.writeInfoLine(tabId, strings.errors.forCode(err.code));
    }
  },

  restart: async (workspaceId, tabId) => {
    const tab = findTab(get, workspaceId, tabId);
    if (!tab) return;
    const oldPaneId = tab.paneId;
    const entry = registry.getEntry(tabId);
    registry.dropChannel(tabId);
    entry?.term.reset();
    if (oldPaneId) {
      useLeftoverStore.getState().clear(oldPaneId);
      markPaneKilled(oldPaneId);
      await ptyKill(oldPaneId).catch(() => {});
    }
    updateTab(set, workspaceId, tabId, {
      status: "idle",
      exitCode: undefined,
      paneId: undefined,
      pid: undefined,
      closing: false,
    });
    await get().start(workspaceId, tabId);
  },

  onExit: (paneId, exitCode) => {
    if (killedPanes.delete(paneId)) return;
    const found = findTabByPaneId(get, paneId);
    if (!found) {
      earlyExits.set(paneId, exitCode);
      return;
    }
    applyExit(set, get, found.workspaceId, found.tab.id, exitCode);
  },

  runningCount: (workspaceId) => {
    const ws = get().byWorkspace[workspaceId];
    if (!ws) return 0;
    return ws.tabs.filter((t) => t.status === "running" || t.status === "starting").length;
  },

  findTabByPaneId: (paneId) => findTabByPaneId(get, paneId),

  setSplit: (workspaceId, left, right) => {
    const ws = get().byWorkspace[workspaceId];
    if (!ws || left === right) return;
    if (!ws.tabs.some((t) => t.id === left) || !ws.tabs.some((t) => t.id === right)) return;
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...ws, activeTabId: left, splitTabId: right } } }));
    schedulePersist(get().byWorkspace);
  },

  closeSplit: (workspaceId, keep) => {
    const ws = get().byWorkspace[workspaceId];
    if (!ws?.splitTabId) return;
    const activeTabId = keep === "right" ? ws.splitTabId : ws.activeTabId;
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...ws, activeTabId, splitTabId: null } } }));
    schedulePersist(get().byWorkspace);
  },

  setFocusedTab: (workspaceId, tabId) => {
    const ws = get().byWorkspace[workspaceId];
    if (!ws || ws.focusedTabId === tabId) return;
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...ws, focusedTabId: tabId } } }));
  },
}));

/** Testler için (LOW #6): `earlyExits`/`killedPanes`'in sınırlı kaldığını doğrulamak için. */
export function earlyExitsSizeForTest(): number {
  return earlyExits.size;
}
export function killedPanesSizeForTest(): number {
  return killedPanes.size;
}
