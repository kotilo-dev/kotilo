/**
 * Dictation overlay (M2b, CCC spec §22.1): the small window Rust shows bottom-centre while
 * dictating. It never takes focus; it only renders `dictation:overlay` events — a blinking
 * record dot, scrolling level bars and a timer while listening, a spinner while transcribing or
 * cleaning, then the result. Rust decides when it hides and plays the sound cues.
 */
import { useEffect, useRef, useState } from "react";
import { useStrings } from "../../../app/i18n";
import { dictationCancel, onDictationOverlay, type DictationOverlayState } from "../../../lib/ipc";
import { barHeight, BAR_COUNT, overlayLines, pushLevel } from "./overlayLogic";

const HIDDEN: DictationOverlayState = { phase: "hidden", mode: "undecided", elapsedMs: 0, level: 0, result: null, sound: null };

export function DictationOverlay({ onSessionStart }: { onSessionStart?: () => void }) {
  const s = useStrings();
  const t = s.dictation.overlay;
  const [state, setState] = useState<DictationOverlayState>(HIDDEN);
  const [levels, setLevels] = useState<number[]>([]);
  const startRef = useRef(onSessionStart);
  startRef.current = onSessionStart;

  useEffect(() => {
    let previous: DictationOverlayState["phase"] = "hidden";
    const unlisten = onDictationOverlay((next) => {
      if (next.phase === "recording" && previous !== "recording") {
        setLevels([]);
        startRef.current?.();
      }
      if (next.phase === "recording") setLevels((l) => pushLevel(l, next.level));
      previous = next.phase;
      setState(next);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  if (state.phase === "hidden") return null;
  const [primary, secondary] = overlayLines(state, t);
  const busy = state.phase === "transcribing" || state.phase === "cleaning";
  const bars = Array.from({ length: BAR_COUNT }, (_, i) => levels[i - (BAR_COUNT - levels.length)] ?? 0);

  return (
    <div
      role="status"
      aria-label={t.label}
      data-phase={state.phase}
      className="flex h-screen w-screen items-center gap-2.5 overflow-hidden rounded-card border border-border bg-surface-2 px-3 text-text"
    >
      <div className="flex size-[18px] shrink-0 items-center justify-center" aria-hidden="true">
        {state.phase === "recording" && <span data-testid="record-dot" className="size-2.5 animate-blink rounded-full bg-blocked" />}
        {busy && <span data-testid="spinner" className="size-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />}
        {state.phase === "result" && state.result && <ResultIcon ok={state.result.ok} />}
      </div>
      {state.phase === "recording" && (
        <div role="meter" aria-label={t.level} aria-valuemin={0} aria-valuemax={1} aria-valuenow={state.level} className="flex h-6 shrink-0 items-center gap-0.5">
          {bars.map((level, i) => (
            <span key={i} data-testid="level-bar" className="w-[3px] rounded-full bg-blocked-ink" style={{ height: `${barHeight(level)}px` }} />
          ))}
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <span
          className={state.phase === "result" ? "line-clamp-2 text-small font-medium leading-snug" : "truncate text-ui font-medium leading-tight"}
          title={primary}
        >
          {primary}
        </span>
        {secondary && <span className="truncate text-label leading-tight text-text-3">{secondary}</span>}
      </div>
      {state.phase !== "result" && (
        <button
          type="button"
          title={t.cancel}
          aria-label={t.cancel}
          onClick={() => void dictationCancel().catch(() => {})}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-button border-0 bg-transparent text-muted hover:bg-surface-4 hover:text-text"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}
    </div>
  );
}

function ResultIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <svg data-testid="result-ok" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-idle">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  ) : (
    <svg data-testid="result-warning" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blocked">
      <path d="M12 3.5L2.5 20h19L12 3.5z" />
      <path d="M12 10v4.5M12 17.5v.01" />
    </svg>
  );
}
