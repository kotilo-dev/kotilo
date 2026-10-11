/**
 * Saf agent takip mantığı (faz5-spec §2.1, §2.4, §2.5, §2.6). Hiçbir fonksiyon Zustand/Tauri'ye
 * dokunmaz — `agentStore.ts` bunları çağırır, testler doğrudan buradan içe aktarır.
 */
import type { Agent, AgentState } from "../../lib/ipc";

/** Sıralama/aciliyet önceliği: blocked > done > working > idle (SPEC §4.2, faz5-spec §2.1/§2.3). */
const STATE_PRIORITY: Record<AgentState, number> = {
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
};

/** blocked > done > working > idle; eşitlikte `sinceMs` eski (küçük) olan üstte. */
export function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    const pa = STATE_PRIORITY[a.state];
    const pb = STATE_PRIORITY[b.state];
    if (pa !== pb) return pa - pb;
    if (a.sinceMs !== b.sinceMs) return a.sinceMs - b.sinceMs;
    return a.id.localeCompare(b.id); // kararlı tie-break (test/render determinizmi)
  });
}

/** Bir workspace'teki agent'lardan en acil olanın durumu; agent yoksa `null`. */
export function urgentStateForWorkspace(agents: Agent[], workspaceId: string): AgentState | null {
  let best: AgentState | null = null;
  for (const a of agents) {
    if (a.workspaceId !== workspaceId) continue;
    if (best === null || STATE_PRIORITY[a.state] < STATE_PRIORITY[best]) best = a.state;
  }
  return best;
}

/** Belirli bir pane'in agent durumu (yoksa `null`). */
export function stateForPane(agents: Agent[], paneId: string): AgentState | null {
  return agents.find((a) => a.paneId === paneId)?.state ?? null;
}

export type AgentCounts = Record<AgentState, number>;

export function countsByState(agents: Agent[]): AgentCounts {
  const counts: AgentCounts = { blocked: 0, working: 0, done: 0, idle: 0 };
  for (const a of agents) counts[a.state]++;
  return counts;
}

/**
 * Geçen süre biçimi: < 60s → `12s`; < 1h → `3m`; aksi → `1h 5m` (dakika 0 ise `1h`).
 * `nowMs`/`sinceMs` epoch ms; negatif fark 0'a kırpılır (saat kayması vb.).
 */
export function formatElapsed(nowMs: number, sinceMs: number): string {
  const totalSeconds = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * `Ctrl+Shift+A` hedef seçimi (faz5-spec §2.4): `sorted` (aciliyet sıralı tüm liste) içinde
 * `focusedPaneId`'den SONRAKİ ilk `blocked` agent; yoksa listedeki ilk `blocked`; hiç yoksa `null`.
 */
export function nextBlockedTarget(sorted: Agent[], focusedPaneId: string | null): Agent | null {
  const firstBlocked = sorted.find((a) => a.state === "blocked") ?? null;
  if (!firstBlocked) return null;
  if (focusedPaneId === null) return firstBlocked;

  const focusedIdx = sorted.findIndex((a) => a.paneId === focusedPaneId);
  if (focusedIdx === -1) return firstBlocked;

  for (let i = focusedIdx + 1; i < sorted.length; i++) {
    if (sorted[i]!.state === "blocked") return sorted[i]!;
  }
  return firstBlocked;
}

export type NotificationKind = "blocked" | "done";

export interface AgentNotification {
  agent: Agent;
  kind: NotificationKind;
}

/**
 * Bildirim kararı (faz5-spec §2.5, §4 revizyon 9 — BAĞLAYICI): yalnızca
 * `prev`'te BULUNAN agent'lar için, ve yalnızca `windowFocused=false` iken. `prev` boşsa (ilk
 * `agents_list()` anlık görüntüsü) her zaman `[]` döner — çağıran bunu zaten "sessiz doldurma"
 * olarak ele alır ama fonksiyon da kendi başına aynı garantiyi verir: yeni görünen (prev'te
 * olmayan) bir agent hiçbir zaman bildirim üretmez.
 */
export function decideNotifications(prev: Agent[], next: Agent[], windowFocused: boolean): AgentNotification[] {
  if (windowFocused) return [];
  const prevById = new Map(prev.map((a) => [a.id, a]));
  const out: AgentNotification[] = [];
  for (const agent of next) {
    const before = prevById.get(agent.id);
    if (!before) continue; // yeni görünen agent — bildirim yok (ilk görüntü sessizce dolar)
    if (before.state === agent.state) continue;
    if (agent.state === "blocked" || agent.state === "done") {
      out.push({ agent, kind: agent.state });
    }
  }
  return out;
}

/** Odak raporlama (faz5-spec §2.1): görünür pane = aktif workspace'in aktif terminal sekmesinin
 * `paneId`'si, ANCAK terminal kolonu görünürse. Sekme yoksa / henüz `paneId` almadıysa `null`. */
export function computeVisiblePaneId(input: {
  activeWorkspaceId: string | null;
  terminalVisible: boolean;
  activeTabPaneId: string | null | undefined;
}): string | null {
  if (!input.activeWorkspaceId || !input.terminalVisible) return null;
  return input.activeTabPaneId ?? null;
}

/**
 * M2: the pane a hub notification is about — its own `paneId`, else the desktop record with
 * the same agent session id (Codex hooks carry no pane id, D-013). `null` when unknown.
 */
export function hubNotificationPane(
  n: { paneId: string | null; sessionId: string | null },
  agents: readonly Agent[],
): string | null {
  if (n.paneId) return n.paneId;
  if (!n.sessionId) return null;
  return agents.find((a) => a.sessionId === n.sessionId)?.paneId ?? null;
}

/** M2 (single owner): a hub notification is shown unless its pane is visible in a focused window. */
export function shouldShowHubNotification(pane: string | null, visiblePaneId: string | null, windowFocused: boolean): boolean {
  return !(windowFocused && pane !== null && pane === visiblePaneId);
}
