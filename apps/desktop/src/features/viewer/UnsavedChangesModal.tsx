import { useEffect, useRef } from "react";
import { useStrings } from "../../app/strings";
import { pushModalOpen } from "../../app/modalStack";

interface UnsavedChangesModalProps {
  title: string;
  body?: string;
  saveLabel: string;
  discardLabel: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

/**
 * "Save / Don't save / Cancel" confirmation when closing a dirty tab or the app (faz3-spec §2
 * "close confirmation", §5.18). Never uses `alert/confirm/prompt`.
 */
export function UnsavedChangesModal({ title, body, saveLabel, discardLabel, onSave, onDiscard, onCancel }: UnsavedChangesModalProps) {
  const strings = useStrings();
  const saveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    saveRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onCancel]);

  // faz7-spec §12.4: mounted only while shown — push on mount, pop on unmount (F1/Help no-op).
  useEffect(() => pushModalOpen(), []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-96 rounded border border-border bg-surface-1 p-4 text-sm text-text shadow-lg">
        <div className="mb-2 font-semibold">{title}</div>
        {body && <div className="mb-4 text-xs text-muted">{body}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded px-2 py-1 text-xs text-muted">
            {strings.confirm.cancel}
          </button>
          <button type="button" onClick={onDiscard} className="rounded px-2 py-1 text-xs text-text">
            {discardLabel}
          </button>
          <button
            ref={saveRef}
            type="button"
            onClick={onSave}
            className="rounded bg-accent px-2 py-1 text-xs font-medium text-on-accent"
          >
            {saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
