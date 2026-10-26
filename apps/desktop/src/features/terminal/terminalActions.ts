/**
 * D-068: terminal extras as user actions (tab menu and command palette), with their toasts.
 */
import { strings } from "../../app/strings";
import { useTerminalStore } from "../../stores/terminalStore";
import { useToastStore } from "../../stores/toastStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { copyRecentOutput, focusTerminal, resetTerminalModes } from "./terminalRegistry";

export function resetWithToast(tabId: string): void {
  resetTerminalModes(tabId);
  useToastStore.getState().show(strings.terminal.resetTerminalDone);
  requestAnimationFrame(() => focusTerminal(tabId));
}

export async function copyOutputWithToast(tabId: string): Promise<void> {
  try {
    const copied = await copyRecentOutput(tabId);
    useToastStore.getState().show(copied ? strings.terminal.copiedRecentOutput : strings.terminal.nothingToCopy);
  } catch {
    useToastStore.getState().show(strings.toast.genericError);
  }
}

/** The terminal the palette commands act on: the focused half of a split, else the active tab. */
export function currentTerminalTabId(): string | null {
  const workspaceId = useWorkspaceStore.getState().activeId;
  if (!workspaceId) return null;
  const ws = useTerminalStore.getState().byWorkspace[workspaceId];
  return ws?.focusedTabId ?? ws?.activeTabId ?? null;
}
