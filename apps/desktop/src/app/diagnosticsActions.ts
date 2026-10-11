/**
 * "Collect diagnostics" / "Open logs folder" — shared between the command palette (`App.tsx`,
 * category "Help") and Settings → About (`SettingsModal.tsx`), faz7-spec.md §4.2/§5.
 */
import { clipboardWriteText, diagnosticsCollect, diagnosticsOpenLogs } from "../lib/ipc";
import { useToastStore } from "../stores/toastStore";
import { strings } from "./strings";

/**
 * Backend already reveals the zip in Explorer (§9.6: `reveal_item_in_dir`). This copies the
 * path to the clipboard and shows the success/failure toast either way. A failure is already
 * logged by `ipc.ts`'s central wrapper (§9.5) — no need to log it again here.
 */
export async function collectDiagnostics(): Promise<void> {
  try {
    const { path } = await diagnosticsCollect();
    try {
      await clipboardWriteText(path);
    } catch {
      // The zip was still written — the toast's wording assumes the copy succeeded, but a
      // failed clipboard write shouldn't be reported as a failed diagnostics collection.
    }
    useToastStore.getState().show(strings.toast.diagnosticsSaved);
  } catch {
    useToastStore.getState().show(strings.toast.diagnosticsFailed);
  }
}

export async function openLogsFolder(): Promise<void> {
  try {
    await diagnosticsOpenLogs();
  } catch {
    useToastStore.getState().show(strings.toast.openLogsFailed);
  }
}
