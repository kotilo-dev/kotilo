/**
 * Processes still running under a pane's shell after its agent exited (0.3.2, `pty:leftover`
 * from Rust). The pane shows a strip with a Stop button; nothing is killed automatically.
 * Keyed by pane id; cleared by an empty list, a dismiss or the pane's end.
 */
import { create } from "zustand";
import { onPtyLeftover } from "../lib/ipc";

interface LeftoverStore {
  byPane: Record<string, string[]>;
  /** `[]` clears the pane's entry. */
  apply: (paneId: string, processes: string[]) => void;
  clear: (paneId: string) => void;
}

export const useLeftoverStore = create<LeftoverStore>((set, get) => ({
  byPane: {},
  apply: (paneId, processes) => {
    if (processes.length === 0) {
      get().clear(paneId);
      return;
    }
    const current = get().byPane[paneId];
    if (current && current.length === processes.length && current.every((p, i) => p === processes[i])) return;
    set((s) => ({ byPane: { ...s.byPane, [paneId]: processes } }));
  },
  clear: (paneId) => {
    if (!(paneId in get().byPane)) return;
    set((s) => {
      const byPane = { ...s.byPane };
      delete byPane[paneId];
      return { byPane };
    });
  },
}));

let installed = false;
export function installLeftoverListener(): void {
  if (installed) return;
  installed = true;
  void onPtyLeftover(({ paneId, processes }) => useLeftoverStore.getState().apply(paneId, processes));
}
