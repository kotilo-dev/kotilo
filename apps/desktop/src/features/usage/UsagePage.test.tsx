import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const hubRequest = vi.fn();
vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ipc")>()),
  hubRequest: (...args: unknown[]) => hubRequest(...args),
}));

import { UsagePage } from "./UsagePage";
import { useI18nStore } from "../../app/i18n";
import type { DailyUsage } from "../../lib/hubTypes";
import { agentsIn, dailyBars, daysToLoad, relativeShares, weekDelta, weekStart, weeklyBars } from "./usageLogic";
import { niceMax } from "./BarChart";

const days: DailyUsage[] = [
  { date: "2026-10-03", tokens: 1000, costUsd: 1.5, hasUnpricedEntries: false, sessions: 2, byAgent: { "claude-code": { tokens: 1000, costUsd: 1.5, hasUnpricedEntries: false } } },
  { date: "2026-10-04", tokens: 3000, costUsd: 0, hasUnpricedEntries: true, sessions: 1, byAgent: { codex: { tokens: 3000, costUsd: 0, hasUnpricedEntries: true } } },
];
const totals = { input: 1, output: 1, cacheCreate: 0, cacheRead: 0, tokens: 3000, costUsd: 0, hasUnpricedEntries: true, entries: 4 };

function routes(path: string): unknown {
  if (path.startsWith("/v1/usage/daily")) return days;
  if (path.startsWith("/v1/usage/blocks"))
    return [{ id: "b1", start: "2026-10-04T10:00:00Z", end: "2026-10-04T15:00:00Z", lastEntryAt: null, isGap: false, isActive: true, totals }];
  if (path.startsWith("/v1/usage/breakdown")) return [{ key: "codex", name: "codex", totals }];
  return [];
}

beforeEach(() => {
  useI18nStore.setState({ preference: "en", language: "en" });
  hubRequest.mockReset().mockImplementation((_m: string, path: string) => Promise.resolve(routes(path)));
});

describe("UsagePage", () => {
  it("renders the daily chart, blocks and breakdown", async () => {
    render(<UsagePage />);
    expect(await screen.findByRole("img", { name: "Daily tokens over the last 30 days" })).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("switches the metric and the breakdown grouping", async () => {
    render(<UsagePage />);
    await screen.findByRole("img", { name: "Daily tokens over the last 30 days" });
    fireEvent.click(screen.getByRole("radio", { name: "Cost" }));
    expect(screen.getByRole("img", { name: "Daily cost over the last 30 days" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "By model" }));
    await waitFor(() => expect(hubRequest).toHaveBeenCalledWith("GET", "/v1/usage/breakdown?by=model&days=30"));
  });

  it("shows the not-running state", async () => {
    hubRequest.mockReset().mockRejectedValue({ code: "hub_unavailable", message: "down" });
    render(<UsagePage />);
    expect(await screen.findByText("Background service not running")).toBeInTheDocument();
  });

  it("logic: agents, bars per agent, shares, nice axis max", () => {
    expect(agentsIn(days)).toEqual(["claude-code", "codex"]);
    const codexCost = dailyBars(days, "cost", "codex");
    expect(codexCost.map((b) => b.display)).toEqual(["$0.00", "—"]);
    expect(dailyBars(days, "tokens", null).map((b) => b.value)).toEqual([1000, 3000]);
    expect(relativeShares([5, 10, 0])).toEqual([0.5, 1, 0]);
    expect(niceMax(3200)).toBe(5000);
    expect(niceMax(0)).toBe(1);
  });

  it("switches to the weekly view with a week-over-week change", async () => {
    render(<UsagePage />);
    await screen.findByRole("img", { name: "Daily tokens over the last 30 days" });
    fireEvent.click(screen.getByRole("radio", { name: "Weeks" }));
    expect(screen.getByRole("img", { name: "Weekly tokens over the last 12 weeks" })).toBeInTheDocument();
    expect(screen.getByText("Weekly usage · last 12 weeks")).toBeInTheDocument();
    expect(hubRequest.mock.calls.some(([, path]) => /^\/v1\/usage\/daily\?days=(7[8-9]|8[0-4])$/.test(path as string))).toBe(true);
  });

  it("logic: Monday weeks, load span, weekly bars, week delta", () => {
    expect(weekStart("2026-11-12")).toBe("2026-11-09"); // Thursday → Monday
    expect(weekStart("2026-11-09")).toBe("2026-11-09");
    expect(weekStart("2026-11-15")).toBe("2026-11-09"); // Sunday belongs to the week before
    expect(weekStart("2026-03-30")).toBe("2026-03-30"); // DST week in Europe
    expect(daysToLoad("2026-11-09")).toBe(78); // Monday: 11 full weeks + 1 day
    expect(daysToLoad("2026-11-15")).toBe(84);
    expect(daysToLoad("2026-11-12", 2)).toBe(30); // never shorter than the Days view

    const day = (date: string, tokens: number, agent = "claude-code", unpriced = false): DailyUsage => ({
      date, tokens, costUsd: unpriced ? 0 : tokens / 1000, hasUnpricedEntries: unpriced, sessions: 1,
      byAgent: { [agent]: { tokens, costUsd: unpriced ? 0 : tokens / 1000, hasUnpricedEntries: unpriced } },
    });
    const series = [day("2026-11-02", 100), day("2026-11-03", 200), day("2026-11-05", 50, "codex", true), day("2026-11-09", 300), day("2026-11-10", 0), day("2026-11-11", 60)];
    const weeks = weeklyBars(series, "tokens", null, 3);
    expect(weeks.map((b) => [b.key, b.value])).toEqual([["2026-10-26", 0], ["2026-11-02", 350], ["2026-11-09", 360]]);
    expect(weeklyBars(series, "cost", null, 3)[1].display).toBe("$0.30"); // priced part shown, like the daily bars
    expect(weeklyBars(series, "cost", "codex", 3)[1].display).toBe("—"); // only unpriced usage that week
    expect(weeklyBars(series, "tokens", "codex", 3).map((b) => b.value)).toEqual([0, 50, 0]);
    expect(weeklyBars([], "tokens", null)).toEqual([]);
    // Mon–Wed this week (360) vs Mon–Wed last week (100 + 200): +20 %; Thursday's codex day is outside the span.
    expect(weekDelta(series, "tokens", null)).toBeCloseTo(0.2);
    expect(weekDelta(series, "tokens", "codex")).toBeNull();
  });
});
