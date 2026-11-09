/**
 * 0.6: git worktrees per workspace (`worktree_list`). Loaded on demand (`ensure`, used by the
 * terminal tab badges) or while a view watches the workspace (Mission control's panel), which
 * also refreshes it on `fs:changed` / `fs:rescan`, debounced: a list call runs git status per
 * worktree, so a burst of agent edits becomes one call. Actions refresh it afterwards. The
 * open worktree dialog lives here too, so the workspace menu, the palette and Mission control
 * can all open it. Nothing is persisted.
 */
import { create } from "zustand";
import { onFsChanged, onFsRescan, worktreeList, type WorktreeList } from "../lib/ipc";

export const WORKTREES_DEBOUNCE_MS = 1500;

export interface WorkspaceWorktrees {
  status: "loading" | "ready" | "error";
  list: WorktreeList | null;
}

export type WorktreeDialog =
  | { kind: "create"; workspaceId: string }
  | { kind: "compare"; workspaceId: string; name: string }
  | { kind: "merge"; workspaceId: string; name: string }
  | { kind: "remove"; workspaceId: string; name: string };

interface WorktreeStore {
  byWorkspace: Record<string, WorkspaceWorktrees>;
  /** Workspaces a view currently shows; only these refresh on file events. */
  watched: Record<string, number>;
  dialog: WorktreeDialog | null;
  refresh: (workspaceId: string) => Promise<void>;
  /** Loads once if never loaded (badges); no file-event refresh. */
  ensure: (workspaceId: string) => void;
  /** Starts watching (and loads once); returns the matching unwatch. */
  watch: (workspaceId: string) => () => void;
  openDialog: (dialog: WorktreeDialog) => void;
  closeDialog: () => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** A refresh requested while one runs reruns once afterwards (the first may have missed the change). */
const running = new Map<string, { again: boolean }>();

export const useWorktreeStore = create<WorktreeStore>((set, get) => ({
  byWorkspace: {},
  watched: {},
  dialog: null,

  refresh: async (workspaceId) => {
    const run = running.get(workspaceId);
    if (run) {
      run.again = true;
      return;
    }
    const state = { again: false };
    running.set(workspaceId, state);
    set((s) => {
      const prev = s.byWorkspace[workspaceId];
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { status: prev?.list ? "ready" : "loading", list: prev?.list ?? null } } };
    });
    try {
      const list = await worktreeList(workspaceId);
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: { status: "ready", list } } }));
    } catch {
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: { status: "error", list: s.byWorkspace[workspaceId]?.list ?? null } } }));
    } finally {
      running.delete(workspaceId);
    }
    if (state.again) void get().refresh(workspaceId);
  },

  ensure: (workspaceId) => {
    if (get().byWorkspace[workspaceId] || running.has(workspaceId)) return;
    void get().refresh(workspaceId);
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

  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
}));

/** Debounced refresh for a watched workspace. */
export function scheduleWorktreesRefresh(workspaceId: string): void {
  if (!useWorktreeStore.getState().watched[workspaceId]) return;
  const pending = timers.get(workspaceId);
  if (pending) clearTimeout(pending);
  timers.set(
    workspaceId,
    setTimeout(() => {
      timers.delete(workspaceId);
      void useWorktreeStore.getState().refresh(workspaceId);
    }, WORKTREES_DEBOUNCE_MS),
  );
}

let listening = false;

function installListeners(): void {
  if (listening) return;
  listening = true;
  void onFsChanged(({ workspaceId }) => scheduleWorktreesRefresh(workspaceId));
  void onFsRescan(({ workspaceId }) => scheduleWorktreesRefresh(workspaceId));
}

/** Test hook. */
export function resetWorktreeStoreForTests(): void {
  listening = false;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  running.clear();
  useWorktreeStore.setState({ byWorkspace: {}, watched: {}, dialog: null });
}
