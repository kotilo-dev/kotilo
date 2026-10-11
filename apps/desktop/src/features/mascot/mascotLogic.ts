/**
 * M6 mascot state (pure; ported from the hub's former `MascotStateResolver`). The main window
 * combines its own agents (Rust tracker) and the hub's sessions into one list, resolves one
 * mascot state from it and sends that to the mascot window (`useMascotBridge.ts`).
 *
 * Priority: perm > error > input > sweat > work > done (3 s after a finished turn) > sleep.
 * Do not disturb / quiet hours always sleep.
 */
import type { Agent } from "../../lib/ipc";
import type { BuddySettings, QuietHours, SessionDto, SessionState, UsageCurrent } from "../../lib/hubTypes";

export type MascotState = "sleep" | "done" | "work" | "sweat" | "input" | "perm" | "error";

/** What one agent is doing, normalized over both sources. */
export type EntryState = "permission" | "error" | "input" | "working" | "idle";

export interface MascotEntry {
  /** Pane id when the agent runs in one of our panes, else `s:<sessionId>`. */
  key: string;
  state: EntryState;
  /** When the entry entered `state` (ms). */
  sinceMs: number;
  /** Start of the current turn when known (hub `turnStartedAt`), for the "finished a long turn" check. */
  turnStartedMs: number | null;
  agent: Agent | null;
  session: SessionDto | null;
}

export interface MascotInputs {
  entries: readonly MascotEntry[];
  /** A burn projection warning fired for the active usage block. */
  burn: boolean;
  /** Latest finished long turn (ms). */
  lastCompletedAt: number | null;
  doNotDisturb: boolean;
  /** `buddy.celebrate`; off = never `done`. */
  celebrate: boolean;
}

export const DONE_DURATION_MS = 3_000;
export const MAX_SPEED = 1.6;

const RANK: Record<EntryState, number> = { permission: 0, error: 1, input: 2, working: 3, idle: 4 };

/** Hub state → entry state; null for sessions that don't count (ended, unknown, stale). */
export function sessionEntryState(state: SessionState): EntryState | null {
  switch (state) {
    case "WaitingPermission":
      return "permission";
    case "WaitingInput":
      return "input";
    case "Error":
      return "error";
    case "Working":
      return "working";
    case "Idle":
      return "idle";
    default:
      return null;
  }
}

/** The Rust tracker's `blocked` comes from permission requests / permission prompts. */
export function agentEntryState(state: Agent["state"]): EntryState {
  switch (state) {
    case "blocked":
      return "permission";
    case "working":
      return "working";
    default:
      return "idle";
  }
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Own agents + hub sessions, one entry per agent. A hub session that belongs to one of our panes
 * (same `paneId`, or the agent's `sessionId`) is merged into that agent: the hub's waiting /
 * error states are more specific than `blocked` / `idle`, otherwise the more urgent of the two
 * wins (one source may lag the other by a moment).
 */
export function mergeEntries(agents: readonly Agent[], sessions: readonly SessionDto[]): MascotEntry[] {
  const entries: MascotEntry[] = [];
  const used = new Set<string>();

  for (const agent of agents) {
    const session = sessions.find(
      (s) => !used.has(s.sessionId) && ((s.paneId !== null && s.paneId === agent.paneId) || (agent.sessionId !== null && s.sessionId === agent.sessionId)),
    );
    if (session) used.add(session.sessionId);
    const own = agentEntryState(agent.state);
    const hub = session ? sessionEntryState(session.state) : null;
    const useHub = hub !== null && (hub === "permission" || hub === "input" || hub === "error" || RANK[hub] < RANK[own]);
    entries.push({
      key: agent.paneId,
      state: useHub ? hub : own,
      sinceMs: useHub ? (parseMs(session?.stateSince) ?? agent.sinceMs) : agent.sinceMs,
      turnStartedMs: parseMs(session?.turnStartedAt),
      agent,
      session: session ?? null,
    });
  }

  for (const session of sessions) {
    if (used.has(session.sessionId)) continue;
    const state = sessionEntryState(session.state);
    if (state === null) continue;
    entries.push({
      key: `s:${session.sessionId}`,
      state,
      sinceMs: parseMs(session.stateSince) ?? 0,
      turnStartedMs: parseMs(session.turnStartedAt),
      agent: null,
      session,
    });
  }
  return entries;
}

export function resolveMascotState(inputs: MascotInputs, nowMs: number): MascotState {
  if (inputs.doNotDisturb) return "sleep";
  const has = (state: EntryState) => inputs.entries.some((e) => e.state === state);
  if (has("permission")) return "perm";
  if (has("error")) return "error";
  if (has("input")) return "input";
  const working = has("working");
  if (working && inputs.burn) return "sweat";
  if (working) return "work";
  const done = inputs.lastCompletedAt;
  if (inputs.celebrate && done !== null && nowMs >= done && nowMs - done < DONE_DURATION_MS) return "done";
  return "sleep";
}

/** Walking speed: 1 for one working agent, +0.15 for each further one, at most 1.6. */
export function speedFactor(entries: readonly MascotEntry[]): number {
  const working = entries.filter((e) => e.state === "working").length;
  return Math.min(MAX_SPEED, 1 + 0.15 * Math.max(0, working - 1));
}

/** The entry in `state` that has waited longest (click target). */
export function oldestIn(entries: readonly MascotEntry[], state: EntryState): MascotEntry | null {
  let best: MascotEntry | null = null;
  for (const e of entries) {
    if (e.state === state && (best === null || e.sinceMs < best.sinceMs)) best = e;
  }
  return best;
}

export type ClickTarget = { kind: "entry"; entry: MascotEntry } | { kind: "usage" } | { kind: "none" };

/** What a click on the mascot in `state` opens. */
export function clickTarget(state: MascotState, entries: readonly MascotEntry[]): ClickTarget {
  const entryState: EntryState | null = state === "perm" ? "permission" : state === "input" ? "input" : state === "error" ? "error" : null;
  if (entryState) {
    const entry = oldestIn(entries, entryState);
    return entry ? { kind: "entry", entry } : { kind: "none" };
  }
  return state === "sweat" ? { kind: "usage" } : { kind: "none" };
}

/**
 * A turn finished: an entry that was working is idle now and its turn lasted at least
 * `minTurnMs` (the hub's `rules.minTurnForCompleted`, the same notion as `session.completed`).
 */
export function finishedLongTurn(prev: readonly MascotEntry[], next: readonly MascotEntry[], minTurnMs: number, nowMs: number): boolean {
  return prev.some((p) => {
    if (p.state !== "working") return false;
    const n = next.find((e) => e.key === p.key);
    if (!n || n.state !== "idle") return false;
    const start = p.turnStartedMs ?? p.sinceMs;
    return nowMs - start >= minTurnMs;
  });
}

/** `HH:mm[:ss]` → seconds since midnight; null when malformed. */
function secondsOfDay(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 3_600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

/** Same rule as the hub's `NotificationGate`: DND until a moment, or local quiet hours (may wrap midnight). */
export function isDoNotDisturb(doNotDisturbUntil: string | null, quietHours: QuietHours, now: Date): boolean {
  const until = parseMs(doNotDisturbUntil);
  if (until !== null && now.getTime() < until) return true;
  if (!quietHours.enabled) return false;
  const start = secondsOfDay(quietHours.start);
  const end = secondsOfDay(quietHours.end);
  if (start === null || end === null) return false;
  const t = now.getHours() * 3_600 + now.getMinutes() * 60 + now.getSeconds();
  if (start === end) return true;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/** Sweat: the burn warning fired for this very block (same start) and the block hasn't ended. */
export function isBurning(burnBlockStart: string | null, usage: UsageCurrent | null, nowMs: number): boolean {
  const block = usage?.activeBlock;
  if (!burnBlockStart || !block || block.start !== burnBlockStart) return false;
  const end = parseMs(block.end);
  return end === null || nowMs < end;
}

/** Hidden until a moment ("Hide for 1 hour"); null when not hidden now. */
export function hiddenUntilMs(buddy: BuddySettings, nowMs: number): number | null {
  const until = parseMs(buddy.mascotHiddenUntil);
  return until !== null && until > nowMs ? until : null;
}

export type MascotScale = 2 | 3 | 4;

export interface MascotLabels {
  aria: string;
  hideHour: string;
  turnOff: string;
  settings: string;
  /** M7: "Open assistant" menu item; left out while the assistant is off. */
  openAssistant?: string;
}

/** `mascot_set_config` payload (contract with the Rust side). */
export interface MascotConfig {
  enabled: boolean;
  scale: MascotScale;
  walkArea: "taskbar" | "corner";
  celebrate: boolean;
  position: number;
  labels: MascotLabels;
}

export function normalizeScale(scale: number): MascotScale {
  return scale === 2 || scale === 4 ? scale : 3;
}

export function mascotConfig(buddy: BuddySettings, labels: MascotLabels, nowMs: number): MascotConfig {
  return {
    enabled: buddy.mascotEnabled && hiddenUntilMs(buddy, nowMs) === null,
    scale: normalizeScale(buddy.mascotScale),
    walkArea: buddy.walkArea === "corner" ? "corner" : "taskbar",
    celebrate: buddy.celebrate,
    position: Math.min(1, Math.max(0, Number.isFinite(buddy.mascotPosition) ? buddy.mascotPosition : 0.85)),
    labels,
  };
}

/** One-time suggestion: the mascot is off, never offered, and an agent just started working. */
export function shouldOffer(buddy: BuddySettings, entries: readonly MascotEntry[]): boolean {
  return !buddy.mascotEnabled && !buddy.mascotOffered && entries.some((e) => e.state === "working");
}
