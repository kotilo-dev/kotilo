import { useTerminalStore } from "../../stores/terminalStore";
import { focusTerminalWhenReady } from "./terminalRegistry";

/**
 * Focuses a just-activated tab's terminal once it is on show; gives up if the user picked another tab meanwhile.
 * Only the tab's own workspace is checked: switching to another workspace finishes asynchronously (IPC round
 * trip), so the global active workspace may still be the old one during the first frames.
 */
export function focusTabWhenShown(tabId: string): void {
  focusTerminalWhenReady(tabId, {
    stillWanted: () =>
      Object.values(useTerminalStore.getState().byWorkspace).some(
        (ws) => ws?.activeTabId === tabId || ws?.splitTabId === tabId,
      ),
  });
}
