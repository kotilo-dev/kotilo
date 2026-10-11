/**
 * QuickPick dosya modu boş sorgu (faz6-spec §5.2): "aktif workspace'in açık sekmeleri (en son
 * etkinleşen önce)". `viewerStore`'un kendisi bu sırayı tutmaz (yalnızca `activeTabId`) — bu
 * modül `activate`/`openFile` sonrası değişen `activeTabId`'yi izleyip workspace başına bir
 * "en son aktifleşen önce" listesi tutar. Sıralamanın kendisi (`orderByRecency`) saf ve test'li;
 * izleme (`installRecentTabsTracking`) yan etkili taraf.
 */
import { useViewerStore } from "../../stores/viewerStore";

const recentByWorkspace = new Map<string, string[]>();
let installed = false;

export function installRecentTabsTracking(): void {
  if (installed) return;
  installed = true;
  let prevByWorkspace = useViewerStore.getState().byWorkspace;
  useViewerStore.subscribe((state) => {
    for (const [workspaceId, ws] of Object.entries(state.byWorkspace)) {
      const prevActive = prevByWorkspace[workspaceId]?.activeTabId;
      if (ws.activeTabId && ws.activeTabId !== prevActive) {
        const list = recentByWorkspace.get(workspaceId) ?? [];
        recentByWorkspace.set(workspaceId, [ws.activeTabId, ...list.filter((id) => id !== ws.activeTabId)]);
      }
    }
    prevByWorkspace = state.byWorkspace;
  });
}

export function recentOrderFor(workspaceId: string): readonly string[] {
  return recentByWorkspace.get(workspaceId) ?? [];
}

/**
 * Saf sıralama: `tabIds` (o an açık sekmeler) `recencyOrder`'a (en yeni önce) göre sıralanır;
 * hiç aktifleşmemiş (recency listesinde olmayan) sekmeler sona, aralarındaki göreli sıra
 * korunarak (kararlı sıralama) eklenir.
 */
export function orderByRecency(tabIds: string[], recencyOrder: readonly string[]): string[] {
  const rank = new Map(recencyOrder.map((id, i) => [id, i]));
  return [...tabIds].sort((a, b) => {
    const ra = rank.get(a);
    const rb = rank.get(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0;
  });
}

export function resetRecentTabsForTest(): void {
  recentByWorkspace.clear();
  installed = false;
}
