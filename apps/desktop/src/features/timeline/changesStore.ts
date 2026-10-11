/**
 * M4: changed files per workspace (`git_changes`: working copy vs HEAD). Loaded when the rail
 * shows a workspace and refreshed on `fs:changed` / `fs:rescan` for that workspace, debounced
 * (an agent editing several files triggers one git run). Nothing is persisted.
 */
import { create } from "zustand";
import { gitChanges, onFsChanged, onFsRescan, type GitChanges } from "../../lib/ipc";

export const CHANGES_DEBOUNCE_MS = 800;

export interface WorkspaceChanges {
  status: "loading" | "ready" | "error";
  changes: GitChanges | null;
}

interface ChangesStore {
  byWorkspace: Record<string, WorkspaceChanges>;
  /** Workspaces the rail currently shows; only these refresh on file events. */
  watched: Record<string, number>;
  refresh: (workspaceId: string) => Promise<void>;
  /** Starts watching (and loads once); returns the matching unwatch. */
  watch: (workspaceId: string) => () => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** A refresh requested while one is running reruns once afterwards (the first may have missed the change). */
const running = new Map<string, { again: boolean }>();

export const useChangesStore = create<ChangesStore>((set, get) => ({
  byWorkspace: {},
  watched: {},

  refresh: async (workspaceId) => {
    const run = running.get(workspaceId);
    if (run) {
      run.again = true;
      return;
    }
    const state = { again: false };
    running.set(workspaceId, state);
    set((s) => ({
      byWorkspace: { ...s.byWorkspace, [workspaceId]: { status: s.byWorkspace[workspaceId]?.changes ? "ready" : "loading", changes: s.byWorkspace[workspaceId]?.changes ?? null } },
    }));
    try {
      const changes = await gitChanges(workspaceId);
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: { status: "ready", changes } } }));
    } catch {
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: { status: "error", changes: null } } }));
    } finally {
      running.delete(workspaceId);
    }
    if (state.again) void get().refresh(workspaceId);
  },

  watch: (workspaceId) => {
    installListeners();
    set((s) => ({ watched: { ...s.watched, [workspaceId]: (s.watched[workspaceId] ?? 0) + 1 } }));
    void get().refresh(workspaceId);
    return () =>
      set((s) => {
        const watched = { ...s.watched };
        const count = (watched[workspaceId] ?? 1) - 1;
        if (count <= 0) delete watched[workspaceId];
        else watched[workspaceId] = count;
        return { watched };
      });
  },
}));

/** Debounced refresh for a watched workspace. */
export function scheduleChangesRefresh(workspaceId: string): void {
  if (!useChangesStore.getState().watched[workspaceId]) return;
  const pending = timers.get(workspaceId);
  if (pending) clearTimeout(pending);
  timers.set(
    workspaceId,
    setTimeout(() => {
      timers.delete(workspaceId);
      void useChangesStore.getState().refresh(workspaceId);
    }, CHANGES_DEBOUNCE_MS),
  );
}

let listening = false;

function installListeners(): void {
  if (listening) return;
  listening = true;
  void onFsChanged(({ workspaceId }) => scheduleChangesRefresh(workspaceId));
  void onFsRescan(({ workspaceId }) => scheduleChangesRefresh(workspaceId));
}

/** Test hook. */
export function resetChangesStoreForTests(): void {
  listening = false;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  running.clear();
  useChangesStore.setState({ byWorkspace: {}, watched: {} });
}
