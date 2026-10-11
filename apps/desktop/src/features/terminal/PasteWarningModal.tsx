import { useEffect, useRef, useState } from "react";
import { useStrings } from "../../app/strings";
import { pushModalOpen } from "../../app/modalStack";

interface PasteWarningModalProps {
  lines: number;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}

/**
 * Multi-line paste warning (faz6-spec §7): "Paste N lines into the terminal?"
 * [Paste] [Cancel] + "Don't ask again" (when ticked the `warnMultilinePaste` setting is turned
 * off – the actual call happens in the caller of `onConfirm(dontAskAgain)`, this component only
 * carries the user's choice). Enter = Paste, Esc = Cancel; on close focus returns to the
 * terminal (the caller runs `term.focus()` after `onConfirm`/`onCancel`).
 */
export function PasteWarningModal({ lines, onConfirm, onCancel }: PasteWarningModalProps) {
  const strings = useStrings();
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // LOW fix #16: `onConfirm`/`onCancel` (and the `dontAskAgain` state) are read through refs,
  // not inline lambdas – otherwise these dependencies carried a new reference on every render
  // and re-ran the effect, which re-triggered `confirmRef.current?.focus()` on every render and
  // made focusing the checkbox (Tab/Space) impossible. Focus is now applied once on mount; the
  // keydown handler reads the latest values from the refs (it is also installed once on mount).
  const onConfirmRef = useRef(onConfirm);
  const onCancelRef = useRef(onCancel);
  const dontAskAgainRef = useRef(dontAskAgain);
  useEffect(() => {
    onConfirmRef.current = onConfirm;
  }, [onConfirm]);
  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);
  useEffect(() => {
    dontAskAgainRef.current = dontAskAgain;
  }, [dontAskAgain]);

  useEffect(() => {
    confirmRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancelRef.current();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirmRef.current(dontAskAgainRef.current);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
    // Deliberately empty dep list: focus + handler setup once on mount only (§16).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // faz7-spec §12.4: this component only exists in the tree while shown (parent renders it
  // conditionally) — push on mount, pop on unmount so F1 (Help) is a no-op meanwhile.
  useEffect(() => pushModalOpen(), []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={strings.paste.title(lines)}
        className="w-96 rounded border border-border bg-surface-1 p-4 text-sm text-text shadow-lg"
      >
        <div className="mb-3 font-semibold">{strings.paste.title(lines)}</div>
        <label className="mb-4 flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={dontAskAgain} onChange={(e) => setDontAskAgain(e.target.checked)} />
          {strings.paste.dontAskAgain}
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded px-2 py-1 text-xs text-muted">
            {strings.paste.cancel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => onConfirm(dontAskAgain)}
            className="rounded bg-accent px-2 py-1 text-xs font-medium text-on-accent"
          >
            {strings.paste.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
