/**
 * M2: live hub data from `/v1/stream` (sessions, usage, limits, health, task counts), kept for every
 * screen. Notifications are dispatched to `notificationHandler`, set by the toast owner.
 */
import { create } from "zustand";
import { hubRequest, onHubEvent, onHubStatus } from "../lib/ipc";
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

const notificationObservers = new Set<(n: NotificationDto) => void>();

/** Who shows hub notifications (single owner, ARCHITECTURE §2.1). */
export function setHubNotificationHandler(handler: ((n: NotificationDto) => void) | null): void {
  notificationHandler = handler;
}

/** Read-only observers that react to a notification without showing it (M6 mascot: burn warning). */
export function observeHubNotifications(observer: (n: NotificationDto) => void): () => void {
  notificationObservers.add(observer);
  return () => notificationObservers.delete(observer);
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
        for (const observer of notificationObservers) observer(message.data);
        break;
    }
  },
  setConnected: (connected) => set({ connected }),
}));

/** D-056: the hub route that marks one session's finished work as seen. */
export function sessionSeenPath(session: Pick<SessionDto, "agent" | "sessionId">): string {
  return `/v1/sessions/${encodeURIComponent(session.agent)}/${encodeURIComponent(session.sessionId)}/seen`;
}

const seenInFlight = new Set<string>();

/**
 * D-056: the user looked at a session's finished work. The flag is cleared locally right away
 * (the hub publishes the same change on the `sessions` stream); failures are ignored, the hub
 * keeps the session unseen and the next stream frame shows that again.
 */
export async function markSessionSeen(session: Pick<SessionDto, "agent" | "sessionId">): Promise<void> {
  const key = `${session.agent}:${session.sessionId}`;
  if (seenInFlight.has(key)) return;
  seenInFlight.add(key);
  const { sessions } = useHubStore.getState();
  if (sessions.some((s) => s.agent === session.agent && s.sessionId === session.sessionId && s.unseen)) {
    useHubStore.setState({
      sessions: sessions.map((s) => (s.agent === session.agent && s.sessionId === session.sessionId ? { ...s, unseen: false } : s)),
    });
  }
  try {
    await hubRequest<unknown>("POST", sessionSeenPath(session));
  } catch {
    // Hub unavailable / older hub: nothing else to do.
  } finally {
    seenInFlight.delete(key);
  }
}

/** D-056: "Mark all as seen" (Mission). */
export async function markAllSessionsSeen(): Promise<void> {
  const { sessions } = useHubStore.getState();
  if (sessions.some((s) => s.unseen)) useHubStore.setState({ sessions: sessions.map((s) => (s.unseen ? { ...s, unseen: false } : s)) });
  try {
    await hubRequest<unknown>("POST", "/v1/sessions/seen");
  } catch {
    // As above.
  }
}

let started = false;

/** Subscribes once to the Rust-side stream relay. Idempotent. */
export function initHubStore(): void {
  if (started) return;
  started = true;
  void onHubEvent((m) => useHubStore.getState().apply(m));
  void onHubStatus((s) => useHubStore.getState().setConnected(s.connected));
}
