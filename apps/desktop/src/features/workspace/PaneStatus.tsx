/**
 * Pane state visuals (DESIGN_SYSTEM §2.3, §6, §10): a 26px state pill for the header strip
 * and a small dot for lists/status bar. Each state differs by shape or motion as well as
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

/** Compact state marker for lists and the status bar; labelled for screen readers. */
export function PaneStatusDot({ state, label }: { state: PaneVisualState; label?: string }) {
  const family = statusFamily(state);
  const toLabel = usePaneStateLabel();
  const text = label ?? toLabel(state);
  if (family === "error") {
    return (
      <span role="img" aria-label={text} title={text} data-state={state} className="inline-flex shrink-0 text-error">
        <WarningIcon size={10} />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={text}
      title={text}
      data-state={state}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[family]}`}
    />
  );
}
