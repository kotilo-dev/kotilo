/** Re-renders every `intervalMs` and returns the current time (for durations like "waiting 1m 12s"). */
import { useEffect, useState } from "react";
import { useAppActive } from "./useAppActive";

/** `active` false (or the window unfocused/hidden) pauses the timer; it resumes with a fresh "now". */
export function useNow(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  const running = useAppActive() && active;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, running]);
  return now;
}
