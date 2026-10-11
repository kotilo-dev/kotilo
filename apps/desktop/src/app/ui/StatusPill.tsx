/**
 * §7.3 state label for a hub session: 26px pill, state tint + ink. Working shimmers with a
 * spinning ring, waiting states pulse, errors carry a warning icon — so a state never relies on
 * color alone (§2.3, §6). Motion stops under prefers-reduced-motion (index.css).
 */
import type { SessionState } from "../../lib/hubTypes";
import { useStrings } from "../i18n";

export type StatusTone = "working" | "blocked" | "done" | "idle" | "error" | "neutral";

export function toneForState(state: SessionState): StatusTone {
  switch (state) {
    case "Working":
      return "working";
    case "WaitingPermission":
    case "WaitingInput":
      return "blocked";
    case "Idle":
      return "idle";
    case "Error":
      return "error";
    default:
      return "neutral";
  }
}

const TONE_CLASS: Record<StatusTone, string> = {
  working: "bg-working-bg text-working-ink",
  blocked: "bg-blocked-bg text-blocked-ink",
  done: "bg-done-bg text-done-ink",
  idle: "bg-idle-bg text-idle-ink",
  error: "bg-error-bg text-error-ink",
  neutral: "bg-surface-5 text-muted",
};

const DOT_CLASS: Record<StatusTone, string> = {
  working: "bg-working",
  blocked: "bg-blocked animate-pulse-halo",
  done: "bg-done",
  idle: "bg-idle",
  error: "bg-error",
  neutral: "bg-faint",
};

export function useStateLabel(): (state: SessionState) => string {
  const s = useStrings();
  return (state) => {
    switch (state) {
      case "Working":
        return s.status.working;
      case "WaitingPermission":
        return s.status.needsPermission;
      case "WaitingInput":
        return s.status.waitingInput;
      case "Idle":
        return s.status.idle;
      case "Error":
        return s.status.error;
      case "Stale":
        return s.status.silent;
      case "Ended":
        return s.ui.ended;
      default:
        return s.ui.unknown;
    }
  };
}

/** `unseen`: an Idle session whose finished work nobody looked at yet shows as Done (D-056). */
export function StatusPill({ state, suffix, unseen = false }: { state: SessionState; suffix?: string; unseen?: boolean }) {
  const s = useStrings();
  const stateLabel = useStateLabel();
  const done = unseen && state === "Idle";
  const label = done ? s.status.done : stateLabel(state);
  const tone = done ? "done" : toneForState(state);
  return (
    <span
      className={`inline-flex h-[26px] shrink-0 items-center gap-[7px] whitespace-nowrap rounded-[13px] px-2.5 text-small font-semibold ${TONE_CLASS[tone]}`}
    >
      {tone === "working" ? (
        <svg aria-hidden width="10" height="10" viewBox="0 0 24 24" className="animate-spin" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <path d="M21 12a9 9 0 1 1-9-9" />
        </svg>
      ) : tone === "error" ? (
        <svg aria-hidden width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3 2 21h20L12 3z" />
          <path d="M12 10v4M12 18h.01" />
        </svg>
      ) : (
        <span aria-hidden className={`h-2 w-2 rounded-full ${DOT_CLASS[tone]}`} />
      )}
      <span className={tone === "working" ? "shimmer-text" : undefined}>{label}</span>
      {suffix && <span className="font-mono font-medium opacity-80">· {suffix}</span>}
    </span>
  );
}
