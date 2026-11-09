/**
 * 0.7 docs check (D-074): the `docs_check` report per workspace. Loaded while a view watches the
 * workspace (the file tree's badges for the active workspace, the Docs tab) – the first watcher
 * loads it, so activating a workspace checks it – and refreshed on `fs:changed` / `fs:rescan`,
 * debounced 1.5 s: a check runs git log per doc, so a burst of agent edits becomes one call.
 * `fs:changed` only names parent folders (and `.git` is hidden from the watcher), so any change
 * outside `.kotilo/worktrees/` counts: a deleted source file can create a missing finding as
 * much as an edited doc, and a commit always comes with file changes. Nothing is persisted.
 */
import { create } from "zustand";
import { docsCheck, docsMarkReviewed, onFsChanged, onFsRescan, toAppError, type AppError, type DocsReport } from "../lib/ipc";

export const DOCS_DEBOUNCE_MS = 1500;

export type DocsFilter = "all" | "missing" | "stale";

/** The Docs tab's filter and expanded rows; kept here so they survive switching tabs. */
export interface DocsViewState {
  filter: DocsFilter;
  expanded: readonly string[];
}

export const DEFAULT_DOCS_VIEW: DocsViewState = { filter: "all", expanded: [] };

export interface WorkspaceDocs {
  status: "loading" | "ready" | "error";
  report: DocsReport | null;
  error: AppError | null;
}

interface DocsStore {
  byWorkspace: Record<string, WorkspaceDocs>;
  /** Workspaces a view currently shows; only these refresh on file events. */
  watched: Record<string, number>;
  view: Record<string, DocsViewState>;
  setFilter: (workspaceId: string, filter: DocsFilter) => void;
  toggleExpanded: (workspaceId: string, path: string) => void;
  refresh: (workspaceId: string) => Promise<void>;
  /** Starts watching (the first watcher loads it); returns the matching unwatch. */
  watch: (workspaceId: string) => () => void;
  /** Writes the doc's reviewed commit into `.kotilo/docs.toml`, then re-checks. Returns the error, if any. */
  markReviewed: (workspaceId: string, path: string) => Promise<AppError | null>;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** A refresh requested while one runs reruns once afterwards (the first may have missed the change). */
const running = new Map<string, { again: boolean; done: Promise<void> }>();

export const useDocsStore = create<DocsStore>((set, get) => ({
  byWorkspace: {},
  watched: {},
  view: {},

  setFilter: (workspaceId, filter) =>
    set((s) => ({ view: { ...s.view, [workspaceId]: { ...(s.view[workspaceId] ?? DEFAULT_DOCS_VIEW), filter } } })),

  toggleExpanded: (workspaceId, path) =>
    set((s) => {
      const prev = s.view[workspaceId] ?? DEFAULT_DOCS_VIEW;
      const expanded = prev.expanded.includes(path) ? prev.expanded.filter((p) => p !== path) : [...prev.expanded, path];
      return { view: { ...s.view, [workspaceId]: { ...prev, expanded } } };
    }),

  refresh: async (workspaceId) => {
    const run = running.get(workspaceId);
    if (run) {
      run.again = true;
      return run.done;
    }
    let finish = () => {};
    const state = { again: false, done: new Promise<void>((resolve) => (finish = resolve)) };
    running.set(workspaceId, state);
    set((s) => {
      const prev = s.byWorkspace[workspaceId];
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { status: "loading", report: prev?.report ?? null, error: null } } };
    });
    try {
      const report = await docsCheck(workspaceId);
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: { status: "ready", report, error: null } } }));
    } catch (e) {
      set((s) => ({
        byWorkspace: { ...s.byWorkspace, [workspaceId]: { status: "error", report: s.byWorkspace[workspaceId]?.report ?? null, error: toAppError(e) } },
      }));
    } finally {
      running.delete(workspaceId);
    }
    if (state.again) await get().refresh(workspaceId);
    finish();
  },

  watch: (workspaceId) => {
    installListeners();
    const first = !get().watched[workspaceId];
    set((s) => ({ watched: { ...s.watched, [workspaceId]: (s.watched[workspaceId] ?? 0) + 1 } }));
    if (first) void get().refresh(workspaceId);
    return () =>
      set((s) => {
        const watched = { ...s.watched };
        const count = (watched[workspaceId] ?? 1) - 1;
        if (count <= 0) delete watched[workspaceId];
        else watched[workspaceId] = count;
        return { watched };
      });
  },

  markReviewed: async (workspaceId, path) => {
    try {
      await docsMarkReviewed(workspaceId, path);
    } catch (e) {
      return toAppError(e);
    }
    await get().refresh(workspaceId);
    return null;
  },
}));

/** `fs:changed` dirs that can affect the check: anything but worktree folders (they have their own checkout). */
export function docsRelevantDirs(dirs: readonly string[]): boolean {
  return dirs.some((d) => d !== ".kotilo/worktrees" && !d.startsWith(".kotilo/worktrees/"));
}

/** Debounced refresh for a watched workspace. */
export function scheduleDocsRefresh(workspaceId: string): void {
  if (!useDocsStore.getState().watched[workspaceId]) return;
  const pending = timers.get(workspaceId);
  if (pending) clearTimeout(pending);
  timers.set(
    workspaceId,
    setTimeout(() => {
      timers.delete(workspaceId);
      void useDocsStore.getState().refresh(workspaceId);
    }, DOCS_DEBOUNCE_MS),
  );
}

let listening = false;

function installListeners(): void {
  if (listening) return;
  listening = true;
  void onFsChanged(({ workspaceId, dirs }) => {
    if (docsRelevantDirs(dirs)) scheduleDocsRefresh(workspaceId);
  });
  void onFsRescan(({ workspaceId }) => scheduleDocsRefresh(workspaceId));
}

/** Test hook. */
export function resetDocsStoreForTests(): void {
  listening = false;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  running.clear();
  useDocsStore.setState({ byWorkspace: {}, watched: {}, view: {} });
}
