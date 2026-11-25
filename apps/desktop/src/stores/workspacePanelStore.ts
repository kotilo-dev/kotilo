/**
 * Which tab of the Workspaces panel is shown. Not persisted: every start begins on Files (or on
 * Workspaces when there is no active workspace; see `effectivePanelTab`).
 */
import { create } from "zustand";

export type PanelTab = "files" | "workspaces";

interface WorkspacePanelStore {
  /** The user's explicit choice; `null` = the default for the current state. */
  tab: PanelTab | null;
  setTab: (tab: PanelTab) => void;
}

export const useWorkspacePanelStore = create<WorkspacePanelStore>((set) => ({
  tab: null,
  setTab: (tab) => set({ tab }),
}));

/** Files by default; Workspaces when there is nothing to show files of. */
export function effectivePanelTab(tab: PanelTab | null, hasActiveWorkspace: boolean): PanelTab {
  if (!hasActiveWorkspace) return "workspaces";
  return tab ?? "files";
}
