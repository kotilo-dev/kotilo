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
import { agentsIn, dailyBars, relativeShares } from "./usageLogic";
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
});
