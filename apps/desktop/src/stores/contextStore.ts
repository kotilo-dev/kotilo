/**
 * 0.9 agent context (D-076): the adapters with context data (`context_agents`, loaded once), the
 * `context_report` per workspace + agent and the read-only previews (`context_read`) of files the
 * report lists. Loaded when the tab shows a workspace/agent pair and on "Refresh"; nothing is
 * persisted and there is no file watcher (the report is cheap to rebuild on demand).
 */
import { create } from "zustand";
import { contextAgents, contextRead, contextReport, toAppError, type AppError, type ContextAgent, type ContextReport } from "../lib/ipc";

export interface AgentContextEntry {
  status: "loading" | "ready" | "error";
  report: ContextReport | null;
  error: AppError | null;
}

export interface ContextPreview {
  status: "loading" | "ready" | "error";
  text: string;
  truncated: boolean;
  error: AppError | null;
}

/** The file the tab previews (absolute path as the report lists it) and its title. */
export interface PreviewTarget {
  agent: string;
  path: string;
  display: string;
}

interface ContextStore {
  agents: ContextAgent[] | null;
  agentsError: AppError | null;
  /** Keyed by `reportKey(workspaceId, agent)`. */
  reports: Record<string, AgentContextEntry>;
  /** Keyed by `previewKey(workspaceId, agent, path)`. */
  previews: Record<string, ContextPreview>;
  /** The open preview per workspace (survives switching tabs). */
  preview: Record<string, PreviewTarget | null>;
  loadAgents: () => Promise<void>;
  /** Loads the report unless it is already there (or loading). */
  ensure: (workspaceId: string, agent: string) => void;
  refresh: (workspaceId: string, agent: string) => Promise<void>;
  /** Opens the preview pane for a file outside the workspace and reads it (cached until refresh). */
  openPreview: (workspaceId: string, target: PreviewTarget) => void;
  closePreview: (workspaceId: string) => void;
}

export const reportKey = (workspaceId: string, agent: string) => `${workspaceId}\u0000${agent}`;
export const previewKey = (workspaceId: string, agent: string, path: string) => `${workspaceId}\u0000${agent}\u0000${path}`;

let agentsLoading: Promise<void> | null = null;

export const useContextStore = create<ContextStore>((set, get) => ({
  agents: null,
  agentsError: null,
  reports: {},
  previews: {},
  preview: {},

  loadAgents: () => {
    if (get().agents) return Promise.resolve();
    agentsLoading ??= contextAgents()
      .then((agents) => set({ agents, agentsError: null }))
      .catch((e) => set({ agentsError: toAppError(e) }))
      .finally(() => (agentsLoading = null));
    return agentsLoading;
  },

  ensure: (workspaceId, agent) => {
    if (get().reports[reportKey(workspaceId, agent)]) return;
    void get().refresh(workspaceId, agent);
  },

  refresh: async (workspaceId, agent) => {
    const key = reportKey(workspaceId, agent);
    const prefix = `${key}\u0000`;
    set((s) => ({
      reports: { ...s.reports, [key]: { status: "loading", report: s.reports[key]?.report ?? null, error: null } },
      // The files may have changed: previews of this pair are read again when shown.
      previews: Object.fromEntries(Object.entries(s.previews).filter(([k]) => !k.startsWith(prefix))),
    }));
    const open = get().preview[workspaceId];
    if (open && open.agent === agent) void readPreview(workspaceId, open);
    try {
      const report = await contextReport(workspaceId, agent);
      set((s) => ({ reports: { ...s.reports, [key]: { status: "ready", report, error: null } } }));
    } catch (e) {
      set((s) => ({ reports: { ...s.reports, [key]: { status: "error", report: s.reports[key]?.report ?? null, error: toAppError(e) } } }));
    }
  },

  openPreview: (workspaceId, target) => {
    set((s) => ({ preview: { ...s.preview, [workspaceId]: target } }));
    if (!get().previews[previewKey(workspaceId, target.agent, target.path)]) void readPreview(workspaceId, target);
  },

  closePreview: (workspaceId) => set((s) => ({ preview: { ...s.preview, [workspaceId]: null } })),
}));

async function readPreview(workspaceId: string, target: PreviewTarget): Promise<void> {
  const key = previewKey(workspaceId, target.agent, target.path);
  const put = (p: ContextPreview) => useContextStore.setState((s) => ({ previews: { ...s.previews, [key]: p } }));
  put({ status: "loading", text: "", truncated: false, error: null });
  try {
    const { text, truncated } = await contextRead(workspaceId, target.agent, target.path);
    put({ status: "ready", text, truncated, error: null });
  } catch (e) {
    put({ status: "error", text: "", truncated: false, error: toAppError(e) });
  }
}

/** Test hook. */
export function resetContextStoreForTests(): void {
  agentsLoading = null;
  useContextStore.setState({ agents: null, agentsError: null, reports: {}, previews: {}, preview: {} });
}
