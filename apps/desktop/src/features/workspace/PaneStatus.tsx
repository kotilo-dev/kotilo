/**
 * Pane state visuals (DESIGN_SYSTEM §2.3, §6, §10): a 26px state pill for the header strip
 * and a 12px state icon for lists/status bar. Each state differs by shape or motion as well as
 * color — Working spins + shimmers, waiting states pulse, errors carry a warning icon.
 */
import { useStrings } from "../../app/i18n";
import { statusFamily, type PaneVisualState } from "./paneSession";

const PILL_CLASS: Record<ReturnType<typeof statusFamily>, string> = {
  working: "bg-working-bg text-working-ink",
  blocked: "bg-blocked-bg text-blocked-ink",
  done: "bg-done-bg text-done-ink",
  idle: "bg-idle-bg text-idle-ink",
  error: "bg-error-bg text-error-ink",
};

/** The dot inside the pill (non-working, non-error states). */
const DOT_CLASS: Record<ReturnType<typeof statusFamily>, string> = {
  working: "bg-working",
  blocked: "bg-blocked animate-pulse-halo",
  done: "bg-done",
  idle: "bg-idle",
  error: "bg-error",
};

export function usePaneStateLabel(): (state: PaneVisualState) => string {
  const s = useStrings();
  return (state) => {
    switch (state) {
      case "working":
        return s.status.working;
      case "permission":
        return s.status.needsPermission;
      case "input":
        return s.status.waitingInput;
      case "done":
        return s.status.done;
      case "idle":
        return s.status.idle;
      case "error":
        return s.status.error;
    }
  };
}

function WarningIcon({ size }: { size: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 2 21h20L12 3z" />
      <path d="M12 10v4M12 18h.01" />
    </svg>
  );
}

/** §7.3 state label: Working shimmer + spin, waiting pulse, error icon. */
export function PaneStatePill({ state, suffix }: { state: PaneVisualState; suffix?: string }) {
  const label = usePaneStateLabel()(state);
  const family = statusFamily(state);
  return (
    <span
      data-state={state}
      className={`inline-flex h-[26px] shrink-0 items-center gap-[7px] whitespace-nowrap rounded-[13px] px-2.5 text-small font-semibold ${PILL_CLASS[family]}`}
    >
      {family === "working" ? (
        <svg aria-hidden width="10" height="10" viewBox="0 0 24 24" className="animate-spin" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <path d="M21 12a9 9 0 1 1-9-9" />
        </svg>
      ) : family === "error" ? (
        <WarningIcon size={11} />
      ) : (
        <span aria-hidden className={`h-2 w-2 rounded-full ${DOT_CLASS[family]}`} />
      )}
      <span className={family === "working" ? "shimmer-text" : undefined}>{label}</span>
      {suffix && <span className="font-mono font-medium opacity-80">· {suffix}</span>}
    </span>
  );
}

const ICON_CLASS: Record<ReturnType<typeof statusFamily>, string> = {
  working: "text-working",
  blocked: "text-blocked animate-pulse-halo rounded-full",
  done: "text-done",
  idle: "text-idle",
  error: "text-error",
};

/** 0.3.2: one small glyph per state (same colours as before, now also a distinct shape). */
function StateGlyph({ state, size }: { state: PaneVisualState; size: number }) {
  const common = {
    "aria-hidden": true,
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (state) {
    case "working":
      return (
        <svg {...common} strokeWidth={3} className="motion-safe:animate-spin">
          <path d="M21 12a9 9 0 1 1-9-9" />
        </svg>
      );
    case "permission":
      return (
        <svg {...common}>
          <path d="M12 2.5l8.5 3.5v5.5c0 5-3.6 8.4-8.5 10-4.9-1.6-8.5-5-8.5-10V6z" />
          <path d="M12 8v4.5M12 16.2h.01" />
        </svg>
      );
    case "input":
      return (
        <svg {...common}>
          <path d="M4 4.5h16v11.5H10l-6 4.5z" />
          <path d="M8.5 10.3h.01M12 10.3h.01M15.5 10.3h.01" strokeWidth={3.2} />
        </svg>
      );
    case "done":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9.5" />
          <path d="M7.8 12.3l2.9 2.9 5.6-6" />
        </svg>
      );
    case "idle":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
        </svg>
      );
    case "error":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9.5" />
          <path d="M9 9l6 6M15 9l-6 6" />
        </svg>
      );
  }
}

/** Compact state marker for lists and the status bar; labelled for screen readers. */
export function PaneStatusDot({ state, label }: { state: PaneVisualState; label?: string }) {
  const family = statusFamily(state);
  const toLabel = usePaneStateLabel();
  const text = label ?? toLabel(state);
  return (
    <span
      role="img"
      aria-label={text}
      title={text}
      data-state={state}
      className={`inline-flex h-3 w-3 shrink-0 items-center justify-center ${ICON_CLASS[family]}`}
    >
      <StateGlyph state={state} size={12} />
    </span>
  );
}
