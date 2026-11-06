/**
 * D-072: the Kotilo Deck connection as the UI sees it: status (settings) and the deck's latest
 * pomodoro state (status-bar chip). The pomodoro is cleared whenever the deck is not connected.
 */
import { create } from "zustand";
import type { CompanionStatus, PomodoroState } from "../lib/ipc";

interface CompanionState {
  status: CompanionStatus;
  pomodoro: PomodoroState | null;
  setStatus: (status: CompanionStatus) => void;
  setPomodoro: (pomodoro: PomodoroState) => void;
}

export const useCompanionStore = create<CompanionState>((set) => ({
  status: { state: "notRunning" },
  pomodoro: null,
  setStatus: (status) => set(status.state === "connected" ? { status } : { status, pomodoro: null }),
  setPomodoro: (pomodoro) => set((st) => (st.status.state === "connected" ? { pomodoro } : {})),
}));
