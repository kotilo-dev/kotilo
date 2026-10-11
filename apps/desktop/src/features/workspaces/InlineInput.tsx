import { useEffect, useRef, useState } from "react";
import type { AppError } from "../../lib/ipc";
import { useStrings } from "../../app/strings";

interface InlineInputProps {
  initialValue: string;
  placeholder?: string;
  /** Preselect the file name without its extension (VS Code behaviour). */
  selectBaseNameOnly?: boolean;
  onSubmit: (value: string) => Promise<AppError | null>;
  onCancel: () => void;
}

/**
 * VS Code style inline edit box: Enter confirms, Esc cancels, an error shows below the row
 * (faz2-spec §6). Shared by new file/folder, rename and workspace rename.
 */
export function InlineInput({ initialValue, placeholder, selectBaseNameOnly, onSubmit, onCancel }: InlineInputProps) {
  const strings = useStrings();
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (selectBaseNameOnly) {
      const dot = initialValue.lastIndexOf(".");
      el.setSelectionRange(0, dot > 0 ? dot : initialValue.length);
    } else {
      el.select();
    }
    // Run on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    if (busy) return;
    const trimmed = value;
    if (trimmed === "") {
      setError({ code: "invalid_name", message: strings.errors.forCode("invalid_name") });
      return;
    }
    setBusy(true);
    const err = await onSubmit(trimmed);
    setBusy(false);
    if (err) setError(err);
    // On success the parent closes it (by removing the inline input from its state).
  }

  return (
    <div className="flex flex-col">
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={busy}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation(); // keep the tree's own onKeyDown (F2/Delete/arrows) from firing
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!busy) onCancel();
        }}
        className={`w-full rounded-sm border bg-bg px-1 py-0 text-xs text-text ${error ? "border-blocked" : "border-accent"}`}
      />
      {error && (
        <div className="mt-0.5 truncate text-label text-blocked">
          {strings.errors.forCode(error.code)}
        </div>
      )}
    </div>
  );
}
