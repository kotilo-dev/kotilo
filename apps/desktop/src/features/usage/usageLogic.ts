/** Pure helpers for the Usage screen (unit-tested). */
import type { DailyUsage } from "../../lib/hubTypes";
import { formatCost, formatIsoDate, formatTokenCount } from "../../app/ui/format";
import type { BarDatum } from "./BarChart";

export type UsageMetric = "tokens" | "cost";

/** Agents that appear in the series, in first-seen order (a stable filter order). */
export function agentsIn(days: readonly DailyUsage[]): string[] {
  const seen: string[] = [];
  for (const d of days) {
    for (const agent of Object.keys(d.byAgent)) {
      if (!seen.includes(agent)) seen.push(agent);
    }
  }
  return seen;
}

/** One bar per day for the metric, optionally for one agent. Unpriced cost shows "—". */
export function dailyBars(days: readonly DailyUsage[], metric: UsageMetric, agent: string | null): BarDatum[] {
  return days.map((d) => {
    const row = agent === null ? d : d.byAgent[agent] ?? { tokens: 0, costUsd: 0, hasUnpricedEntries: false };
    const value = metric === "tokens" ? row.tokens : row.costUsd;
    const display = metric === "tokens" ? formatTokenCount(row.tokens) : formatCost(row.costUsd, row.hasUnpricedEntries);
    return { key: d.date, label: formatIsoDate(d.date), value, display };
  });
}

/** Share (0..1) of each row relative to the largest one, for inline bars. */
export function relativeShares(values: readonly number[]): number[] {
  const max = Math.max(0, ...values);
  return values.map((v) => (max > 0 ? v / max : 0));
}
