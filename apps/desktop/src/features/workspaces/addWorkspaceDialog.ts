/**
 * Shared by the "+" button and the `workspaces.add` palette entry (faz6-spec §5.1): folder
 * picker dialog, then adds every picked path as a workspace.
 */
import { strings } from "../../app/strings";
import { pickFolders } from "../../lib/ipc";
import { useWorkspaceStore } from "../../stores/workspaceStore";

// Review item 4: guards against two concurrent invocations (e.g. a fast double
// command-palette Enter before the first `pick_folders` call has even returned) opening
// two folder pickers at once. The backend's own `pick_folders` has the same guard
// (`IN_FLIGHT` in `commands/dialog.rs`) for callers that reach it another way; this one
// avoids even sending the second IPC call.
let inFlight = false;

export async function openAddWorkspaceDialog(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Not the plugin's `open()`: opened from the keyboard (palette + Enter) it left the mouse cursor hidden.
    const paths = await pickFolders(strings.workspaces.addDialogTitle);
    for (const path of paths) {
      await useWorkspaceStore.getState().addWorkspace(path);
    }
  } finally {
    inFlight = false;
  }
}
