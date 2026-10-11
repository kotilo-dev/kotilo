/**
 * Pure parts of the dictation overlay (CCC `DictationOverlay.xaml.cs`): level bars, timer and
 * the two text lines for each phase.
 */
import type { DictationOverlayState } from "../../../lib/ipc";
import type { Strings } from "../../../app/strings";

export const BAR_COUNT = 18;

/** Bar height in px for an RMS level: `clamp(3 + sqrt(level) * 40, 3, 24)`. */
export function barHeight(level: number): number {
  const h = 3 + Math.sqrt(Math.max(0, level)) * 40;
  return Math.min(24, Math.max(3, h));
}

/** The latest `BAR_COUNT` levels, oldest first (bars scroll left). */
export function pushLevel(levels: readonly number[], level: number): number[] {
  const next = [...levels, level];
  return next.length > BAR_COUNT ? next.slice(next.length - BAR_COUNT) : next;
}

/** `m:ss`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

type OverlayStrings = Strings["dictation"]["overlay"];

/** First and second line; the second is empty for a result. */
export function overlayLines(state: DictationOverlayState, t: OverlayStrings): [string, string] {
  switch (state.phase) {
    case "recording": {
      const hint = state.mode === "hold" ? t.hintHold : state.mode === "toggle" ? t.hintToggle : t.hintUndecided;
      return [t.listening(formatElapsed(state.elapsedMs)), hint];
    }
    case "transcribing":
      return [t.transcribing, t.hintCancel];
    case "cleaning":
      return [t.cleaning, t.hintCancel];
    case "result": {
      if (!state.result) return ["", ""];
      const message = t.messages[state.result.message];
      return [state.result.detail ? t.withDetail(message, state.result.detail) : message, ""];
    }
    default:
      return ["", ""];
  }
}
