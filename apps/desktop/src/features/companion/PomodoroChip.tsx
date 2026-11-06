/**
 * D-072: the Kotilo Deck pomodoro in the status bar. Counts down from `endsAt` while running
 * (the deck sends no ticks), shows `remaining` while paused, hidden when idle or disconnected.
 */
import { useStrings } from "../../app/i18n";
import { useNow } from "../../app/ui/useNow";
import type { PomodoroState } from "../../lib/ipc";
import { useCompanionStore } from "../../stores/companionStore";

/** Seconds left: from `endsAt` while running, else the deck's `remaining`. */
export function pomodoroSecondsLeft(p: PomodoroState, nowMs: number): number {
  if (p.running && typeof p.endsAt === "number") return Math.max(0, Math.ceil((p.endsAt - nowMs) / 1000));
  return Math.max(0, Math.round(p.remaining));
}

export function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function PomodoroChip() {
  const s = useStrings();
  const pomodoro = useCompanionStore((st) => st.pomodoro);
  const visible = pomodoro !== null && pomodoro.phase !== "idle";
  const now = useNow(1000, visible && pomodoro.running);
  if (!visible) return null;
  const phase = s.companion.pomodoro.phase[pomodoro.phase] ?? pomodoro.phase;
  const clock = formatClock(pomodoroSecondsLeft(pomodoro, now));
  const label = s.companion.pomodoro.label(phase, clock);
  return (
    <span data-pomodoro-chip className="flex items-center gap-1" title={label} aria-label={label}>
      <span className={`h-1.5 w-1.5 rounded-full ${pomodoro.phase === "focus" ? "bg-blocked" : "bg-idle"}`} aria-hidden />
      <span>{phase}</span>
      <span className="font-mono">{clock}</span>
      {!pomodoro.running && <span>({s.companion.pomodoro.paused})</span>}
    </span>
  );
}
