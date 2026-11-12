import { describe, expect, it } from "vitest";
import type { LimitDto, SessionDto, UsageCurrent } from "../lib/hubTypes";
import { en } from "./i18n/en";
import { TRAY_TOOLTIP_MAX, traySummary } from "./traySummary";

const usage: UsageCurrent = {
  at: "2026-11-12T10:00:00Z",
  activeBlock: {
    start: "2026-11-12T08:00:00Z",
    end: "2026-11-12T13:00:00Z",
    tokens: 340_000,
    costUsd: 1.2,
    remainingMinutes: 130,
    tokensPerMinute: 900,
    projectedTokens: 500_000,
    projectedCostUsd: 2,
  },
  today: { tokens: 1_200_000, costUsd: 4.1, sessions: 3 },
  week: { tokens: 5_000_000, costUsd: 20 },
} as UsageCurrent;

const limits: LimitDto[] = [
  { agent: "claude-code", window: "fiveHour", usedPercent: 12.4, resetsAt: "2026-11-12T13:00:00Z" },
  { agent: "claude-code", window: "weekly", usedPercent: 62, resetsAt: "2026-11-15T00:00:00Z" },
];

function session(id: string, state: SessionDto["state"], projectName = "app"): SessionDto {
  return { sessionId: id, agent: "claude-code", projectName, state } as SessionDto;
}

const label = (state: SessionDto["state"]) => (state === "WaitingPermission" ? "Needs permission" : state === "WaitingInput" ? "Waiting for input" : state);

describe("traySummary", () => {
  it("lists today, the block, every limit and the waiting sessions", () => {
    const r = traySummary(
      { connected: true, usage, limits, sessions: [session("a", "WaitingPermission", "api"), session("b", "Working"), session("c", "WaitingInput")] },
      en,
      "Kotilo",
      label,
    );
    expect(r.lines).toEqual([
      "Today: 1.2 M tokens ≈ $4.10",
      "5-hour block: 340k tokens · 2h 10m left",
      "Claude Code · 5-hour 12%",
      "Claude Code · Weekly 62%",
    ]);
    expect(r.waiting.map((w) => w.label)).toEqual(["api · Claude Code · Needs permission", "app · Claude Code · Waiting for input"]);
    expect(r.waiting[0].session.sessionId).toBe("a");
    expect(r.moreWaiting).toBe(0);
    // The tooltip keeps only the highest limit.
    expect(r.tooltip).toBe("Kotilo\nToday 1.2 M · $4.10\nBlock: 2h 10m left\nClaude Code · Weekly 62%\n2 agents waiting");
  });

  it("caps the waiting list and the tooltip length", () => {
    const many = Array.from({ length: 8 }, (_, i) => session(`s${i}`, "WaitingInput", `a-very-long-project-name-${i}`));
    const r = traySummary({ connected: true, usage, limits, sessions: many }, en, "Kotilo".repeat(20), label);
    expect(r.waiting).toHaveLength(5);
    expect(r.moreWaiting).toBe(3);
    expect(r.tooltip.length).toBeLessThanOrEqual(TRAY_TOOLTIP_MAX);
    expect(r.tooltip.endsWith("…")).toBe(true);
  });

  it("says when there is no block, and when the hub is down", () => {
    const idle = traySummary({ connected: true, usage: { ...usage, activeBlock: null }, limits: [], sessions: [] }, en, "Kotilo", label);
    expect(idle.lines).toEqual(["Today: 1.2 M tokens ≈ $4.10", "No active 5-hour block"]);
    expect(idle.tooltip).toBe("Kotilo\nToday 1.2 M · $4.10");

    const down = traySummary({ connected: false, usage: null, limits: [], sessions: [] }, en, "Kotilo", label);
    expect(down.lines).toEqual(["Background service not running"]);
  });

  it("changes its signature only when something visible changes", () => {
    const a = traySummary({ connected: true, usage, limits, sessions: [] }, en, "Kotilo", label);
    const b = traySummary({ connected: true, usage: { ...usage, at: "2026-11-12T10:00:05Z" }, limits, sessions: [] }, en, "Kotilo", label);
    const c = traySummary({ connected: true, usage: { ...usage, today: { ...usage.today, tokens: 1_300_000 } }, limits, sessions: [] }, en, "Kotilo", label);
    expect(b.signature).toBe(a.signature);
    expect(c.signature).not.toBe(a.signature);
  });
});
