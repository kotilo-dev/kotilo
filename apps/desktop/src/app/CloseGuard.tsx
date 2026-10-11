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
import { useToastStore } from "../stores/toastStore";

type Decision = "cancel" | "discard" | "saveAll";

let promptOpen = false;

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

    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (promptOpen) {
          event.preventDefault(); // modal already open: just block, no second modal
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
