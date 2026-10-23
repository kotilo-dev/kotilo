/**
 * App close confirmation (faz3-spec §2 "Close confirmation", §5.18). When any document is dirty
 * (open, unsaved), `getCurrentWindow().onCloseRequested` blocks the close and shows the
 * "Save all / Discard / Cancel" modal.
 *
 * Module-level `promptOpen` flag (single even under StrictMode double mount): a second close
 * request while the modal is open is blocked too but **does not open a second modal** (§5.18).
 *
 * Closing: without dirty documents the event is not blocked; the `onCloseRequested` wrapper
 * calls `destroy()` itself. After confirmation `destroy()` is called directly (not `close()`,
 * which would re-enter this listener). Permission: `core:window:allow-destroy`.
 */
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { strings, useStrings } from "./strings";
import { UnsavedChangesModal } from "../features/viewer/UnsavedChangesModal";
import { collectDirtyDocs, saveAllDirty } from "../features/viewer/unsavedChanges";
import { useSettingsStore } from "../stores/settingsStore";
import { useToastStore } from "../stores/toastStore";
import { onQuitRequested } from "../lib/ipc";

type Decision = "cancel" | "discard" | "saveAll";

let promptOpen = false;
/** D-058: set by the tray's Quit so the next close really closes instead of hiding. */
let quitRequested = false;

/** D-058: brings the main window back from the tray (or from behind other windows). */
export async function showMainWindow(): Promise<void> {
  const win = getCurrentWindow();
  await win.show();
  await win.unminimize();
  await win.setFocus();
}

/** D-058: the tray's Quit – the normal close path (unsaved-changes prompt included), never hidden. */
export async function requestQuit(): Promise<void> {
  // The prompt must be seen: a hidden window comes back first.
  if (collectDirtyDocs().length > 0) await showMainWindow().catch(() => {});
  quitRequested = true;
  try {
    await getCurrentWindow().close();
  } catch {
    quitRequested = false;
  }
}

/** Destroys the window; on failure (e.g. permission) a toast: close cancelled, guard stays active. */
async function destroyWindow() {
  try {
    await getCurrentWindow().destroy();
  } catch {
    useToastStore.getState().show(strings.viewer.closeAppModal.closeFailed);
  }
}

export function CloseGuard() {
  const s = useStrings();
  const [open, setOpen] = useState(false);
  const resolveRef = useRef<((d: Decision) => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let unlistenQuit: (() => void) | undefined;

    // U-3: the macOS menu's Quit (Cmd+Q) with the tray on; without the tray Rust closes the window itself.
    void onQuitRequested(() => void requestQuit()).then((fn) => {
      if (cancelled) fn();
      else unlistenQuit = fn;
    });

    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (promptOpen) {
          event.preventDefault(); // modal already open: just block, no second modal
          return;
        }
        const quitting = quitRequested;
        quitRequested = false;
        if (!quitting && useSettingsStore.getState().settings.window?.closeToTray === true) {
          // D-058: panes and agents keep running; the tray icon brings the window back.
          event.preventDefault();
          await getCurrentWindow().hide();
          return;
        }
        const dirty = collectDirtyDocs();
        if (dirty.length === 0) return; // not blocked → the wrapper calls destroy()
        event.preventDefault(); // before any await (the wrapper checks once the handler returns)

        promptOpen = true;
        setOpen(true);
        const decision = await new Promise<Decision>((resolve) => {
          resolveRef.current = resolve;
        });
        setOpen(false);
        promptOpen = false;

        if (decision === "cancel") return;
        if (decision === "discard") {
          await destroyWindow();
          return;
        }

        const ok = await saveAllDirty(dirty);
        if (!ok) {
          useToastStore.getState().show(strings.viewer.closeAppModal.saveFailed);
          return;
        }
        await destroyWindow();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
      unlistenQuit?.();
    };
  }, []);

  if (!open) return null;

  return (
    <UnsavedChangesModal
      title={s.viewer.closeAppModal.title}
      body={s.viewer.closeAppModal.body}
      saveLabel={s.viewer.closeAppModal.saveAll}
      discardLabel={s.viewer.closeAppModal.discard}
      onCancel={() => resolveRef.current?.("cancel")}
      onDiscard={() => resolveRef.current?.("discard")}
      onSave={() => resolveRef.current?.("saveAll")}
    />
  );
}
