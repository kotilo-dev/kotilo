/**
 * Form controls and page frame shared by the Settings, Projects, Tasks and Dictation screens
 * (DESIGN_SYSTEM §3, §7.10, §9). Tokens only; every control has a visible or aria label.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useStrings } from "../../app/strings";
import { pushModalOpen } from "../../app/modalStack";

// Shared screen primitives (app/ui), re-exported so the Settings / Projects / Tasks / Dictation
// screens import their whole kit from one place.
export { Page, PageHeader } from "../../app/ui/PageHeader";
export { SectionLabel } from "../../app/ui/Card";
export { EmptyState } from "../../app/ui/EmptyState";
export { Segmented } from "../../app/ui/Segmented";

const DEBOUNCE_MS = 400;
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;

const INPUT =
  "rounded-control border border-border bg-surface-3 px-2 py-1.5 text-ui text-text outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-[invalid=true]:border-blocked";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-card border border-border-subtle bg-surface-2 ${className}`}>{children}</div>;
}

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent font-semibold border border-transparent",
  secondary: "bg-surface-5 text-text border border-border",
  danger: "bg-transparent text-blocked-ink border border-[color-mix(in_srgb,var(--status-blocked)_35%,transparent)]",
  ghost: "bg-transparent text-text-2 border border-transparent hover:bg-surface-4",
};

export function Button({
  variant = "secondary",
  children,
  onClick,
  disabled,
  type = "button",
  ariaLabel,
  title,
  small,
}: {
  variant?: ButtonVariant;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  ariaLabel?: string;
  title?: string;
  small?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      className={`${BUTTON[variant]} ${small ? "h-8 px-2.5 text-small" : "h-9 px-3.5 text-ui"} inline-flex items-center gap-2 rounded-button transition-colors duration-150 disabled:cursor-default disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
    >
      {children}
    </button>
  );
}

/** Label + control + optional hint / error, wired with ids for screen readers. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-small font-medium text-text-3">
        {label}
      </label>
      {children({ id, describedBy, invalid: !!error })}
      {hint && (
        <span id={hintId} className="text-meta text-muted">
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} role="alert" className="text-meta text-blocked-ink">
          {error}
        </span>
      )}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  id,
  describedBy,
  invalid,
  placeholder,
  ariaLabel,
  type = "text",
  className = "w-full",
  onKeyDown,
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
  describedBy?: string;
  invalid?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  type?: "text" | "time" | "date" | "number" | "search";
  className?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      id={id}
      type={type}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      className={`${INPUT} ${className}`}
    />
  );
}

export function TextArea({
  value,
  onChange,
  id,
  describedBy,
  invalid,
  rows = 3,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
  describedBy?: string;
  invalid?: boolean;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <textarea
      id={id}
      rows={rows}
      value={value}
      placeholder={placeholder}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
      className={`${INPUT} w-full resize-y`}
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  id,
  describedBy,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
  id?: string;
  describedBy?: string;
  ariaLabel?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value as T)}
      className={`${INPUT} w-full`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-start gap-2.5 text-ui text-text">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 accent-accent" />
      <span className="flex flex-col gap-0.5">
        {label}
        {hint && <span className="text-meta text-muted">{hint}</span>}
      </span>
    </label>
  );
}

/** Thin progress bar (§7.9 look) with a numeric label for screen readers. */
export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} className="h-1.5 w-full overflow-hidden rounded-full bg-track">
      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Inline notice (hub unavailable, load errors). */
export function Notice({ tone = "info", children }: { tone?: "info" | "error" | "warning"; children: ReactNode }) {
  const toneClass =
    tone === "error" ? "border-blocked bg-blocked-bg text-blocked-ink" : tone === "warning" ? "border-working bg-working-bg text-working-ink" : "border-border bg-surface-3 text-text-2";
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-control border px-3 py-2 text-body ${toneClass}`}>
      {children}
    </div>
  );
}

/**
 * §10.5 fix #8 (moved from the old Settings modal): only a whole number within `[min, max]` is
 * valid — anything else is never sent to the backend.
 */
export function parseIntegerInRange(raw: string, min: number, max: number): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/** Text field that commits after a pause or on blur (app settings apply immediately). */
export function DebouncedText({ value, onCommit, placeholder, id }: { value: string; onCommit: (v: string) => void; placeholder?: string; id?: string }) {
  const [local, setLocal] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  // While focused, an echoed value from the store must not move the text under the cursor.
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setLocal(value);
  }, [value]);

  function schedule(v: string) {
    setLocal(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onCommit(v), DEBOUNCE_MS);
  }
  function flush() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    onCommit(local);
  }

  return (
    <input
      id={id}
      type="text"
      value={local}
      placeholder={placeholder}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(e) => schedule(e.target.value)}
      onBlur={() => {
        focusedRef.current = false;
        flush();
      }}
      className={`${INPUT} w-full`}
    />
  );
}

/**
 * Number field that commits only on blur/Enter and only a whole number in range; an invalid
 * value stays in the field, marked invalid, and is never sent.
 */
export function DebouncedNumber({
  value,
  onCommit,
  min = FONT_SIZE_MIN,
  max = FONT_SIZE_MAX,
  id,
}: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  id?: string;
}) {
  const strings = useStrings();
  const [local, setLocal] = useState(String(value));
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setLocal(String(value));
  }, [value]);

  const parsed = parseIntegerInRange(local, min, max);
  const isValid = parsed !== null;

  function commit() {
    if (parsed !== null) onCommit(parsed);
  }

  return (
    <>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        value={local}
        aria-invalid={!isValid}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          focusedRef.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        className={`${INPUT} w-24 font-mono`}
      />
      {!isValid && (
        <div role="alert" className="text-meta text-blocked-ink">
          {strings.settings.invalidNumberRange(min, max)}
        </div>
      )}
    </>
  );
}

/**
 * Modal dialog shell (role="dialog", Esc and outside click cancel, registered in the modal
 * stack so F1 stays a no-op). Focus goes to the first focusable control on open.
 */
export function Dialog({
  title,
  onCancel,
  children,
  footer,
  wide,
}: {
  title: string;
  onCancel: () => void;
  children: ReactNode;
  footer: ReactNode;
  /** 720px instead of 520px (multi-step forms). */
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const first = panelRef.current?.querySelector<HTMLElement>("input, textarea, select, button");
    first?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onCancel]);

  useEffect(() => pushModalOpen(), []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`flex max-h-[85vh] ${wide ? "w-[720px]" : "w-[520px]"} max-w-[92vw] flex-col gap-4 overflow-auto rounded-sheet border border-border bg-surface-4 p-5 shadow-float animate-rise`}
      >
        <h2 id={titleId} className="m-0 text-title font-semibold text-text">
          {title}
        </h2>
        {children}
        <div className="flex flex-wrap justify-end gap-2">{footer}</div>
      </div>
    </div>
  );
}
