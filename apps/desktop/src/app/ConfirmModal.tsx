import { useStrings } from "./strings";
import { Button, Dialog } from "../features/settings/controls";

interface ConfirmModalProps {
  title: string;
  body?: string;
  confirmLabel: string;
  /** `danger` only for deleting / removing; everything else keeps the calm primary button. */
  tone?: "primary" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Our own confirm modal: `alert`/`confirm`/`prompt` are NOT used (faz2-spec §6). Built on the
 * shared Dialog; reusable for hard-to-undo actions such as deleting or removing a workspace.
 */
export function ConfirmModal({ title, body, confirmLabel, tone = "primary", onConfirm, onCancel }: ConfirmModalProps) {
  const strings = useStrings();
  return (
    <Dialog
      title={title}
      onCancel={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {strings.confirm.cancel}
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm} initialFocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body && <p className="m-0 text-ui text-text-2">{body}</p>}
    </Dialog>
  );
}
