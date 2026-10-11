/**
 * M4: per-session activity timelines from the hub, memory only (rule 5: never logged, never
 * persisted). A session is fetched once with `GET /v1/sessions/{agent}/{id}/activity` when the
 * rail shows it; afterwards `activity` stream deltas are merged in. Deltas for sessions nobody
 * asked for are ignored (the full fetch brings them when needed). A reconnect re-fetches.
 */
import { create } from "zustand";
import { hubRequest, onHubEvent, onHubStatus } from "../../lib/ipc";
import type { ActivityDto, ActivityFrame } from "../../lib/hubTypes";
import { useHubStore } from "../../stores/hubStore";
import { applyFrame, applySnapshot, EMPTY_ACTIVITY, sessionKey, type SessionActivity, type SessionRef } from "./timelineLogic";

export interface TrackedActivity extends SessionActivity {
  status: "loading" | "ready";
}

interface ActivityStore {
  bySession: Record<string, TrackedActivity>;
  /** Starts tracking `ref` (fetch + stream deltas). Idempotent unless `force`. */
  ensure: (ref: SessionRef, force?: boolean) => Promise<void>;
  applyFrame: (frame: ActivityFrame) => void;
}

const MAX_TRACKED = 16;

/** Keys with a fetch in flight → whether a stream frame arrived meanwhile. */
const inFlight = new Map<string, { frameSeen: boolean }>();

function activityPath(ref: SessionRef): string {
  return `/v1/sessions/${encodeURIComponent(ref.agent)}/${encodeURIComponent(ref.sessionId)}/activity`;
}

export const useActivityStore = create<ActivityStore>((set, get) => ({
  bySession: {},

  ensure: async (ref, force = false) => {
    installListeners();
    const key = sessionKey(ref);
    if (inFlight.has(key) || (!force && get().bySession[key])) return;
    const flight = { frameSeen: false };
    inFlight.set(key, flight);
    set((s) => {
      const bySession = { ...s.bySession, [key]: { ...(s.bySession[key] ?? EMPTY_ACTIVITY), status: s.bySession[key]?.status ?? "loading" } };
      // Bounded: forget the sessions tracked first.
      const keys = Object.keys(bySession);
      for (const old of keys.slice(0, Math.max(0, keys.length - MAX_TRACKED))) if (old !== key) delete bySession[old];
      return { bySession };
    });
    let dto: ActivityDto;
    try {
      dto = await hubRequest<ActivityDto>("GET", activityPath(ref));
    } catch {
      // Unknown session (404) or hub down: show what the stream brings, if anything.
      dto = { entries: [], plan: null };
    } finally {
      inFlight.delete(key);
    }
    set((s) => {
      const current = s.bySession[key] ?? { ...EMPTY_ACTIVITY, status: "loading" as const };
      return { bySession: { ...s.bySession, [key]: { ...applySnapshot(current, dto, flight.frameSeen), status: "ready" } } };
    });
  },

  applyFrame: (frame) => {
    const key = sessionKey({ agent: frame.agent, sessionId: frame.sessionId });
    const current = get().bySession[key];
    if (!current) return;
    const flight = inFlight.get(key);
    if (flight) flight.frameSeen = true;
    set((s) => ({ bySession: { ...s.bySession, [key]: { ...applyFrame(current, frame), status: current.status } } }));
  },
}));

let listening = false;
/** Seeded from the hub store so the first "connected" after startup is not a reconnect. */
let wasConnected = false;

function installListeners(): void {
  if (listening) return;
  listening = true;
  wasConnected = useHubStore.getState().connected;
  void onHubEvent((m) => {
    if (m.type === "activity") useActivityStore.getState().applyFrame(m.data);
  });
  // Frames sent while disconnected are lost: re-fetch every tracked session on reconnect.
  void onHubStatus(({ connected }) => {
    const reconnected = connected && !wasConnected;
    wasConnected = connected;
    if (!reconnected) return;
    for (const key of Object.keys(useActivityStore.getState().bySession)) {
      const slash = key.indexOf("/");
      void useActivityStore.getState().ensure({ agent: key.slice(0, slash), sessionId: key.slice(slash + 1) }, true);
    }
  });
}

/** Test hook: forget listeners and in-flight fetches. */
export function resetActivityStoreForTests(): void {
  listening = false;
  wasConnected = false;
  inFlight.clear();
  useActivityStore.setState({ bySession: {} });
}
