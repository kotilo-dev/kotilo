import { useEffect, useRef } from "react";
import { useStrings } from "./strings";
import { pushModalOpen } from "./modalStack";

interface ConfirmModalProps {
  title: string;
  body?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Our own confirm modal: `alert`/`confirm`/`prompt` are NOT used (faz2-spec §6). Reusable for
 * hard-to-undo actions such as deleting or removing a workspace.
 */
export function ConfirmModal({ title, body, confirmLabel, onConfirm, onCancel }: ConfirmModalProps) {
  const strings = useStrings();
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
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
      <div
        className="w-80 rounded border border-border bg-surface-1 p-4 text-sm text-text shadow-lg"
      >
        <div className="mb-2 font-semibold">{title}</div>
        {body && (
          <div className="mb-4 text-xs text-muted">
            {body}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2 py-1 text-xs text-muted"
          >
            {strings.confirm.cancel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="rounded bg-blocked px-2 py-1 text-xs font-medium text-on-accent"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
