/**
 * Agent takibi (faz5-spec §2.1). Tek doğruluk kaynağı backend'dir: `agents` yalnızca
 * `agents_list()` (açılış) ve `agents:changed` event'i ile güncellenir (workspace/terminal
 * store'larındaki desenin aynısı — optimistic update yok, `agent_ack` de sadece backend'e
 * haber verir, listeyi kendisi değiştirmez).
 *
 * Odak raporlama (§2.1, §4 revizyon 13): aktif workspace'in aktif terminal sekmesinin
 * `paneId`'si (terminal kolonu görünürse) + pencere focus/blur → `agent_set_focus`,
 * **yalnızca frontend'de** 100 ms debounce edilir (backend anında uygular).
 *
 * Bildirimler (§2.5, §4 revizyon 9): her `agents:changed`'de önceki liste (`get().agents`,
 * henüz üzerine yazılmadan) ile yenisi `decideNotifications`'a verilir — saf karar `agentLogic.ts`'te.
 */
import { create } from "zustand";
import { sameJson } from "../lib/sameJson";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  agentAck,
  agentsList,
  agentSetFocus,
  hooksInstall,
  hooksStatus,
  hooksUninstall,
  onAgentsChanged,
  toAppError,
  type Agent,
  type HooksStatus,
} from "../lib/ipc";
import { strings } from "../app/strings";
import { useToastStore } from "./toastStore";
import { useWorkspaceStore } from "./workspaceStore";
import { useTerminalStore } from "./terminalStore";
import { useLayoutStore } from "./layoutStore";
import { useRouteStore } from "./routeStore";
import {
  computeVisiblePaneId,
  decideNotifications,
  hubNotificationPane,
  shouldShowHubNotification,
} from "../features/agents/agentLogic";
import { notifyAgent, notifyFromHub } from "../features/agents/notifications";
import { setHubNotificationHandler, useHubStore } from "./hubStore";

const FOCUS_DEBOUNCE_MS = 100;

interface AgentStore {
  ready: boolean;
  agents: Agent[];
  hooks: HooksStatus | null;

  init: () => Promise<void>;
  ack: (paneId: string) => void;
  installHooks: () => Promise<void>;
  updateHooks: () => Promise<void>;
  uninstallHooks: () => Promise<void>;
}

type Getter = () => AgentStore;
type Setter = (partial: Partial<AgentStore> | ((s: AgentStore) => Partial<AgentStore>)) => void;

// --- agents:changed dinleyicisi (StrictMode/HMR-güvenli, terminalStore'daki desenin aynısı) ---

let agentsListenerInstalled = false;
let agentsListenerUnlisten: (() => void) | undefined;
// Faz 5 §4 revizyon 9 fix: dinleyici artık `agentsList()` çözülmeden ÖNCE kurulur (aksi
// halde fetch süresince gelen bir `agents:changed` tamamen kaybolurdu) — bu yüzden "ilk
// görüntü sessizce doldurulur" kuralı artık kimin önce geldiğine (event mi, fetch mi)
// bakan bu bayrakla uygulanır: ilk gelen ne ise (`decideNotifications` çağrılmadan)
// `agents`'i o doldurur; `init` da fetch sonucunu, bir event zaten seed olduysa görmezden
// gelir (eskisini ezmez).
let seeded = false;

function activeTabPaneIdFor(workspaceId: string | null): string | null | undefined {
  if (!workspaceId) return undefined;
  const ws = useTerminalStore.getState().byWorkspace[workspaceId];
  if (!ws?.activeTabId) return undefined;
  return ws.tabs.find((t) => t.id === ws.activeTabId)?.paneId;
}

function resolveNotificationContext(agent: Agent): { workspaceName: string; tabTitle: string | null } {
  const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === agent.workspaceId);
  const found = useTerminalStore.getState().findTabByPaneId(agent.paneId);
  return {
    workspaceName: ws?.name ?? "",
    tabTitle: found?.tab.title ?? null,
  };
}

function installAgentsChangedListener(get: Getter, set: Setter): void {
  if (agentsListenerInstalled) return;
  agentsListenerInstalled = true;

  const unlistenPromise = onAgentsChanged((next) => {
    if (!seeded) {
      // Bu event, fetch'ten önce geldi: kendisi seed olur, sessizce (decideNotifications
      // çağrılmaz) — `init`'in kendi fetch sonucu artık bunu ezmeyecek.
      seeded = true;
      set({ agents: next, ready: true });
      return;
    }
    const prev = get().agents;
    // 0.3.2: a repeated frame (same records) changes nothing and re-renders nothing.
    if (sameJson(prev, next)) return;
    // M2: while the hub stream is connected its rule engine decides notifications (single
    // owner, see `installHubNotificationOwner`); the desktop decision is only the fallback.
    const notifications = useHubStore.getState().connected ? [] : decideNotifications(prev, next, windowFocused);
    set({ agents: next });
    for (const n of notifications) {
      const ctx = resolveNotificationContext(n.agent);
      void notifyAgent({
        kind: n.agent.kind,
        adapterId: n.agent.adapterId,
        notificationKind: n.kind,
        workspaceName: ctx.workspaceName,
        tabTitle: ctx.tabTitle,
      });
    }
  });
  void unlistenPromise.then((unlisten) => {
    agentsListenerUnlisten = unlisten;
  });
}

/**
 * Faz 5 §4 revizyon 9: HMR sırasında modül yeniden yüklenirken önceki dinleyici asılı
 * kalmasın — gerçek `import.meta.hot?.dispose` bağlantısı en altta; bu fonksiyon dışa
 * açık tutuldu ki testler `import.meta.hot` olmadan da (vitest'te bu her zaman
 * `undefined` olur) doğrudan çağırıp doğrulayabilsin.
 */
export function resetAgentsListenerForHmr(): void {
  agentsListenerUnlisten?.();
  agentsListenerUnlisten = undefined;
  agentsListenerInstalled = false;
  seeded = false;
}

if (import.meta.hot) {
  import.meta.hot.dispose(resetAgentsListenerForHmr);
}

// --- Odak raporlama (§2.1, §4 revizyon 13): saf hesap `computeVisiblePaneId`, yalnızca
// gönderim burada 100 ms debounce edilir. ---------------------------------------------------

let focusReportingInstalled = false;
let windowFocused = true;
let focusDebounceTimer: ReturnType<typeof setTimeout> | undefined;
let lastSentVisiblePaneId: string | null | undefined;
let lastSentWindowFocused: boolean | undefined;

/** The pane currently on screen (active workspace's active tab, terminal + workspace route visible). */
function currentVisiblePaneId(): string | null {
  const activeWorkspaceId = useWorkspaceStore.getState().activeId;
  // M2: another route (Overview, Usage, …) hides the workspace, so no pane is "seen" then.
  const terminalVisible =
    useLayoutStore.getState().layout.terminalVisible && useRouteStore.getState().route === "workspace";
  return computeVisiblePaneId({
    activeWorkspaceId,
    terminalVisible,
    activeTabPaneId: activeTabPaneIdFor(activeWorkspaceId),
  });
}

/**
 * M2: hub notifications are shown here (the one owner of OS toasts), except for an agent
 * whose pane is on screen in a focused window.
 */
export function installHubNotificationOwner(getAgents: () => Agent[]): void {
  setHubNotificationHandler((n) => {
    const pane = hubNotificationPane(n, getAgents());
    if (!shouldShowHubNotification(pane, currentVisiblePaneId(), windowFocused)) return;
    void notifyFromHub(n);
  });
}

function scheduleSetFocus(): void {
  if (focusDebounceTimer) clearTimeout(focusDebounceTimer);
  focusDebounceTimer = setTimeout(() => {
    focusDebounceTimer = undefined;
    const visiblePaneId = currentVisiblePaneId();
    if (visiblePaneId === lastSentVisiblePaneId && windowFocused === lastSentWindowFocused) return;
    lastSentVisiblePaneId = visiblePaneId;
    lastSentWindowFocused = windowFocused;
    void agentSetFocus(visiblePaneId, windowFocused).catch(() => {});
  }, FOCUS_DEBOUNCE_MS);
}

function installFocusReporting(): void {
  if (focusReportingInstalled) return;
  focusReportingInstalled = true;

  useWorkspaceStore.subscribe(scheduleSetFocus);
  useTerminalStore.subscribe(scheduleSetFocus);
  useLayoutStore.subscribe(scheduleSetFocus);
  useRouteStore.subscribe(scheduleSetFocus);

  const win = getCurrentWindow();
  void win
    .isFocused()
    .then((focused) => {
      windowFocused = focused;
      scheduleSetFocus();
    })
    .catch(() => {});
  void win.onFocusChanged(({ payload }) => {
    windowFocused = payload;
    scheduleSetFocus();
  });

  scheduleSetFocus();
}

let initPromise: Promise<void> | null = null;

export const useAgentStore = create<AgentStore>((set, get) => ({
  ready: false,
  agents: [],
  hooks: null,

  init: () => {
    if (get().ready) return Promise.resolve();
    if (initPromise) return initPromise;

    initPromise = (async () => {
      // Faz 5 §4 revizyon 9 fix: dinleyici `agentsList()` çözülmeden ÖNCE kurulur —
      // aksi halde fetch sürerken gelen bir `agents:changed` tamamen kaybolurdu.
      installAgentsChangedListener(get, set);
      installHubNotificationOwner(() => get().agents);

      let agents: Agent[] = [];
      try {
        agents = await agentsList();
      } catch {
        agents = [];
      }

      let hooks: HooksStatus | null = null;
      try {
        hooks = await hooksStatus();
      } catch {
        hooks = null;
      }

      if (!seeded) {
        // Fetch, herhangi bir event'ten önce çözüldü: ilk görüntüyü sessizce doldurur
        // (decideNotifications çağrılmaz) — ilk `agents:changed` bunu `prev` olarak
        // kullanacak.
        seeded = true;
        set({ agents, hooks, ready: true });
      } else {
        // Bir `agents:changed` fetch'ten önce geldi ve zaten seed oldu — `agents`'i bu
        // (artık bayat olabilecek) fetch sonucuyla ezme, sadece hooks/ready'yi tamamla.
        set({ hooks, ready: true });
      }

      installFocusReporting();
    })().finally(() => {
      initPromise = null;
    });

    return initPromise;
  },

  ack: (paneId) => {
    void agentAck(paneId).catch(() => {});
  },

  installHooks: async () => {
    try {
      await hooksInstall();
      const status = await hooksStatus();
      set({ hooks: status });
      useToastStore.getState().show(strings.agents.toast.installSuccess);
    } catch (e) {
      useToastStore.getState().show(strings.errors.forCode(toAppError(e).code));
    }
  },

  updateHooks: async () => {
    try {
      await hooksInstall();
      const status = await hooksStatus();
      set({ hooks: status });
      useToastStore.getState().show(strings.agents.toast.updateSuccess);
    } catch (e) {
      useToastStore.getState().show(strings.errors.forCode(toAppError(e).code));
    }
  },

  uninstallHooks: async () => {
    try {
      await hooksUninstall();
      const status = await hooksStatus();
      set({ hooks: status });
      useToastStore.getState().show(strings.agents.toast.uninstallSuccess);
    } catch (e) {
      useToastStore.getState().show(strings.errors.forCode(toAppError(e).code));
    }
  },
}));
