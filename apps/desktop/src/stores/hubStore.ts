/**
 * M2: live hub data from `/v1/stream` (sessions, usage, limits, health, task counts), kept for every
 * screen. Notifications are dispatched to `notificationHandler`, set by the toast owner.
 */
import { create } from "zustand";
import { onHubEvent, onHubStatus } from "../lib/ipc";
import type { HealthDto, LimitDto, NotificationDto, SessionDto, StreamMessage, TaskCounts, UsageCurrent } from "../lib/hubTypes";

interface HubState {
  connected: boolean;
  sessions: SessionDto[];
  usage: UsageCurrent | null;
  taskCounts: TaskCounts | null;
  limits: LimitDto[];
  health: HealthDto | null;
  apply: (message: StreamMessage) => void;
  setConnected: (connected: boolean) => void;
}

let notificationHandler: ((n: NotificationDto) => void) | null = null;

/** Who shows hub notifications (single owner, ARCHITECTURE §2.1). */
export function setHubNotificationHandler(handler: ((n: NotificationDto) => void) | null): void {
  notificationHandler = handler;
}

export const useHubStore = create<HubState>((set) => ({
  connected: false,
  sessions: [],
  usage: null,
  limits: [],
  health: null,
  taskCounts: null,
  apply: (message) => {
    switch (message.type) {
      case "sessions":
        set({ sessions: message.data });
        break;
      case "usage":
        set({ usage: message.data });
        break;
      case "limits":
        set({ limits: message.data });
        break;
      case "health":
        set({ health: message.data });
        break;
      case "tasks":
        set({ taskCounts: message.data });
        break;
      case "notification":
        notificationHandler?.(message.data);
        break;
    }
  },
  setConnected: (connected) => set({ connected }),
}));

let started = false;

/** Subscribes once to the Rust-side stream relay. Idempotent. */
export function initHubStore(): void {
  if (started) return;
  started = true;
  void onHubEvent((m) => useHubStore.getState().apply(m));
  void onHubStatus((s) => useHubStore.getState().setConnected(s.connected));
}
