import { describe, expect, it } from "vitest";
import type { Agent } from "../../lib/ipc";
import type { BuddySettings, SessionDto, UsageCurrent } from "../../lib/hubTypes";
import {
  clickTarget,
  DONE_DURATION_MS,
  finishedLongTurn,
  isBurning,
  isDoNotDisturb,
  mascotConfig,
  mergeEntries,
  oldestIn,
  resolveMascotState,
  shouldOffer,
  speedFactor,
  type MascotEntry,
  type MascotInputs,
} from "./mascotLogic";

const NOW = Date.parse("2026-10-11T12:00:00Z");

function session(partial: Partial<SessionDto>): SessionDto {
  return {
    sessionId: "s",
    agent: "claude-code",
    paneId: null,
    projectRoot: "C:/src/app",
    projectName: "app",
    state: "Idle",
    stateSince: new Date(NOW - 60_000).toISOString(),
    lastEventAt: new Date(NOW - 60_000).toISOString(),
    currentTool: null,
    model: null,
    tokens: 0,
    costUsd: null,
    contextUsedPercent: null,
    turnStartedAt: null,
    endedAt: null,
    activeSubagents: 0,
    lastNotification: null,
    error: null,
    tasks: null,
    pendingPermission: null,
    ...partial,
  };
}

function agent(partial: Partial<Agent>): Agent {
  return { id: "a", paneId: "pane-a", workspaceId: "ws", kind: "claude", state: "idle", sinceMs: NOW - 60_000, source: "hook", sessionId: null, ...partial };
}

/** Hub-only entry in `state`, entered `minutesAgo` minutes before NOW. */
function entry(key: string, state: SessionDto["state"], minutesAgo = 1): MascotEntry {
  return mergeEntries([], [session({ sessionId: key, state, stateSince: new Date(NOW - minutesAgo * 60_000).toISOString() })])[0]!;
}

function resolve(entries: MascotEntry[], opts: Partial<Omit<MascotInputs, "entries">> = {}) {
  return resolveMascotState({ entries, burn: false, lastCompletedAt: null, doNotDisturb: false, celebrate: true, ...opts }, NOW);
}

const buddy: BuddySettings = {
  enabled: false,
  mascotEnabled: true,
  mascotOffered: false,
  hotkey: "Ctrl+Alt+B",
  mascotScale: 3,
  walkArea: "taskbar",
  celebrate: true,
  showBuddySessions: false,
  mascotHiddenUntil: null,
  mascotPosition: 0.85,
};

describe("resolveMascotState", () => {
  it("orders perm > error > input > sweat > work > done > sleep", () => {
    const w = entry("w", "Working");
    const i = entry("i", "WaitingInput");
    const e = entry("e", "Error");
    const p = entry("p", "WaitingPermission");
    expect(resolve([w, i, e, p], { burn: true, lastCompletedAt: NOW })).toBe("perm");
    expect(resolve([w, i, e], { burn: true, lastCompletedAt: NOW })).toBe("error");
    expect(resolve([w, i], { burn: true, lastCompletedAt: NOW })).toBe("input");
    expect(resolve([w], { burn: true, lastCompletedAt: NOW })).toBe("sweat");
    expect(resolve([w], { lastCompletedAt: NOW })).toBe("work");
    expect(resolve([entry("idle", "Idle")], { lastCompletedAt: NOW })).toBe("done");
    expect(resolve([entry("idle", "Idle")])).toBe("sleep");
    expect(resolve([])).toBe("sleep");
  });

  it("sweats only while something works", () => {
    expect(resolve([entry("idle", "Idle")], { burn: true })).toBe("sleep");
  });

  it("celebrates for three seconds, never for a future timestamp, and not when celebrate is off", () => {
    expect(resolve([], { lastCompletedAt: NOW - 2_900 })).toBe("done");
    expect(resolve([], { lastCompletedAt: NOW - DONE_DURATION_MS })).toBe("sleep");
    expect(resolve([], { lastCompletedAt: NOW + 1_000 })).toBe("sleep");
    expect(resolve([], { lastCompletedAt: NOW, celebrate: false })).toBe("sleep");
  });

  it("always sleeps in do not disturb", () => {
    expect(resolve([entry("p", "WaitingPermission")], { doNotDisturb: true })).toBe("sleep");
  });

  it("ignores ended, unknown and stale sessions", () => {
    expect(mergeEntries([], [session({ sessionId: "e", state: "Ended" }), session({ sessionId: "u", state: "Unknown" }), session({ sessionId: "x", state: "Stale" })])).toEqual([]);
  });
});

describe("speedFactor and click targets", () => {
  it("speeds up with more working agents, capped at 1.6", () => {
    expect(speedFactor([])).toBe(1);
    expect(speedFactor([entry("a", "Working")])).toBe(1);
    expect(speedFactor(["a", "b", "c"].map((k) => entry(k, "Working")))).toBeCloseTo(1.3, 9);
    expect(speedFactor(Array.from({ length: 20 }, (_, i) => entry(`s${i}`, "Working")))).toBe(1.6);
  });

  it("targets the agent waiting longest", () => {
    const entries = [entry("new", "WaitingPermission", 1), entry("old", "WaitingPermission", 9), entry("w", "Working"), entry("in", "WaitingInput", 3)];
    expect(oldestIn(entries, "permission")?.key).toBe("s:old");
    expect(clickTarget("perm", entries)).toEqual({ kind: "entry", entry: entries[1] });
    expect(clickTarget("input", entries)).toEqual({ kind: "entry", entry: entries[3] });
    expect(clickTarget("error", entries)).toEqual({ kind: "none" });
    expect(clickTarget("sweat", entries)).toEqual({ kind: "usage" });
    expect(clickTarget("work", entries)).toEqual({ kind: "none" });
  });
});

describe("mergeEntries", () => {
  it("maps own agents: blocked is a permission wait, done counts as idle", () => {
    const entries = mergeEntries([agent({ paneId: "p1", state: "blocked" }), agent({ paneId: "p2", state: "working" }), agent({ paneId: "p3", state: "done" })], []);
    expect(entries.map((e) => `${e.key}:${e.state}`)).toEqual(["p1:permission", "p2:working", "p3:idle"]);
  });

  it("counts a hub session in one of our panes once and prefers the hub's more specific state", () => {
    const own = agent({ paneId: "p1", state: "blocked", sinceMs: NOW - 5_000 });
    const hub = session({ sessionId: "h1", paneId: "p1", state: "WaitingInput", stateSince: new Date(NOW - 7_000).toISOString() });
    const entries = mergeEntries([own], [hub]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: "p1", state: "input", sinceMs: NOW - 7_000, agent: own, session: hub });
  });

  it("matches by the agent's session id too and keeps the more urgent state when the hub lags", () => {
    const own = agent({ paneId: "p1", state: "working", sessionId: "h1" });
    const entries = mergeEntries([own], [session({ sessionId: "h1", state: "Idle" }), session({ sessionId: "h2", state: "Working" })]);
    expect(entries.map((e) => `${e.key}:${e.state}`)).toEqual(["p1:working", "s:h2:working"]);

    const errored = mergeEntries([agent({ paneId: "p1", state: "idle" })], [session({ sessionId: "h1", paneId: "p1", state: "Error" })]);
    expect(errored[0]?.state).toBe("error");
  });
});

describe("finishedLongTurn", () => {
  const working = (startedAgo: number): MascotEntry => ({ ...entry("x", "Working"), sinceMs: NOW - 1_000, turnStartedMs: NOW - startedAgo });
  const idle = entry("x", "Idle");

  it("needs working → idle after a turn of at least the threshold", () => {
    expect(finishedLongTurn([working(40_000)], [idle], 30_000, NOW)).toBe(true);
    expect(finishedLongTurn([working(10_000)], [idle], 30_000, NOW)).toBe(false);
    expect(finishedLongTurn([working(40_000)], [], 30_000, NOW)).toBe(false);
    expect(finishedLongTurn([working(40_000)], [{ ...idle, state: "permission" }], 30_000, NOW)).toBe(false);
  });

  it("falls back to the state start without a turn start", () => {
    expect(finishedLongTurn([{ ...entry("x", "Working", 2), turnStartedMs: null }], [idle], 60_000, NOW)).toBe(true);
  });
});

describe("do not disturb, burn, config, offer", () => {
  const local = (h: number, m: number) => new Date(2026, 9, 11, h, m);
  const quiet = { enabled: true, start: "22:00:00", end: "08:00:00" };

  it("follows DND until and quiet hours across midnight", () => {
    expect(isDoNotDisturb(new Date(NOW + 60_000).toISOString(), { ...quiet, enabled: false }, new Date(NOW))).toBe(true);
    expect(isDoNotDisturb(new Date(NOW - 60_000).toISOString(), { ...quiet, enabled: false }, new Date(NOW))).toBe(false);
    expect(isDoNotDisturb(null, quiet, local(23, 30))).toBe(true);
    expect(isDoNotDisturb(null, quiet, local(7, 59))).toBe(true);
    expect(isDoNotDisturb(null, quiet, local(8, 0))).toBe(false);
    expect(isDoNotDisturb(null, { enabled: true, start: "09:00:00", end: "17:00:00" }, local(12, 0))).toBe(true);
    expect(isDoNotDisturb(null, { enabled: true, start: "09:00:00", end: "17:00:00" }, local(18, 0))).toBe(false);
  });

  it("sweats only for the block the warning fired in, until it ends", () => {
    const usage = (start: string, end: string) => ({ activeBlock: { start, end } }) as unknown as UsageCurrent;
    const start = new Date(NOW - 3_600_000).toISOString();
    const end = new Date(NOW + 3_600_000).toISOString();
    expect(isBurning(start, usage(start, end), NOW)).toBe(true);
    expect(isBurning(start, usage(start, end), NOW + 3_600_000)).toBe(false);
    expect(isBurning(start, usage(end, new Date(NOW + 7_200_000).toISOString()), NOW)).toBe(false);
    expect(isBurning(null, usage(start, end), NOW)).toBe(false);
    expect(isBurning(start, null, NOW)).toBe(false);
  });

  it("folds hidden-until into enabled and clamps values", () => {
    const labels = { aria: "a", hideHour: "h", turnOff: "t", settings: "s" };
    expect(mascotConfig(buddy, labels, NOW)).toEqual({ enabled: true, scale: 3, walkArea: "taskbar", celebrate: true, position: 0.85, labels });
    expect(mascotConfig({ ...buddy, mascotHiddenUntil: new Date(NOW + 1_000).toISOString() }, labels, NOW).enabled).toBe(false);
    expect(mascotConfig({ ...buddy, mascotHiddenUntil: new Date(NOW - 1_000).toISOString() }, labels, NOW).enabled).toBe(true);
    expect(mascotConfig({ ...buddy, mascotScale: 1, mascotPosition: 7, walkArea: "corner" }, labels, NOW)).toMatchObject({ scale: 3, position: 1, walkArea: "corner" });
  });

  it("offers once while off and something works", () => {
    const off = { ...buddy, mascotEnabled: false };
    expect(shouldOffer(off, [entry("w", "Working")])).toBe(true);
    expect(shouldOffer(off, [entry("i", "Idle")])).toBe(false);
    expect(shouldOffer({ ...off, mascotOffered: true }, [entry("w", "Working")])).toBe(false);
    expect(shouldOffer(buddy, [entry("w", "Working")])).toBe(false);
  });
});
