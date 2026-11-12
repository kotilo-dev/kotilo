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

/** Weeks shown by the Weeks view (current week included). */
export const WEEKS_SHOWN = 12;
/** Days the Days view shows. */
export const DAYS_SHOWN = 30;

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` → UTC midnight (local calendar dates; UTC math avoids DST shifts). */
function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function isoOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. */
function weekdayIndex(date: string): number {
  return (new Date(dayNumber(date) * DAY_MS).getUTCDay() + 6) % 7;
}

/** Monday of the week `date` falls in. */
export function weekStart(date: string): string {
  return isoOf(dayNumber(date) - weekdayIndex(date));
}

/** Days to load so the Weeks view starts on a Monday and still covers the Days view. */
export function daysToLoad(today: string, weeks = WEEKS_SHOWN): number {
  return Math.max(DAYS_SHOWN, 7 * (weeks - 1) + weekdayIndex(today) + 1);
}

type Totals = { tokens: number; costUsd: number; hasUnpricedEntries: boolean };

function totalsOf(d: DailyUsage, agent: string | null): Totals {
  return agent === null ? d : d.byAgent[agent] ?? { tokens: 0, costUsd: 0, hasUnpricedEntries: false };
}

function sumWeeks(days: readonly DailyUsage[], agent: string | null): Map<string, Totals> {
  const weeks = new Map<string, Totals>();
  for (const d of days) {
    const key = weekStart(d.date);
    const row = totalsOf(d, agent);
    const acc = weeks.get(key) ?? { tokens: 0, costUsd: 0, hasUnpricedEntries: false };
    weeks.set(key, {
      tokens: acc.tokens + row.tokens,
      costUsd: acc.costUsd + row.costUsd,
      hasUnpricedEntries: acc.hasUnpricedEntries || row.hasUnpricedEntries,
    });
  }
  return weeks;
}

/**
 * One bar per Monday-to-Sunday week, the last `weeks` weeks up to the week of the last day
 * (that week is partial). Weeks without data show as zero.
 */
export function weeklyBars(days: readonly DailyUsage[], metric: UsageMetric, agent: string | null, weeks = WEEKS_SHOWN): BarDatum[] {
  if (days.length === 0) return [];
  const sums = sumWeeks(days, agent);
  const last = dayNumber(weekStart(days[days.length - 1].date));
  const bars: BarDatum[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const key = isoOf(last - 7 * i);
    const row = sums.get(key) ?? { tokens: 0, costUsd: 0, hasUnpricedEntries: false };
    bars.push({
      key,
      label: formatIsoDate(key),
      value: metric === "tokens" ? row.tokens : row.costUsd,
      display: metric === "tokens" ? formatTokenCount(row.tokens) : formatCost(row.costUsd, row.hasUnpricedEntries),
    });
  }
  return bars;
}

/**
 * This week so far vs the same weekdays of last week, as a ratio change (0.25 = +25 %).
 * Null when last week had nothing to compare with.
 */
export function weekDelta(days: readonly DailyUsage[], metric: UsageMetric, agent: string | null): number | null {
  if (days.length === 0) return null;
  const today = days[days.length - 1].date;
  const thisStart = dayNumber(weekStart(today));
  const elapsed = dayNumber(today) - thisStart; // 0 on Monday
  let now = 0;
  let before = 0;
  for (const d of days) {
    const n = dayNumber(d.date);
    const row = totalsOf(d, agent);
    const v = metric === "tokens" ? row.tokens : row.costUsd;
    if (n >= thisStart && n <= thisStart + elapsed) now += v;
    else if (n >= thisStart - 7 && n <= thisStart - 7 + elapsed) before += v;
  }
  return before > 0 ? now / before - 1 : null;
}

/** Share (0..1) of each row relative to the largest one, for inline bars. */
export function relativeShares(values: readonly number[]): number[] {
  const max = Math.max(0, ...values);
  return values.map((v) => (max > 0 ? v / max : 0));
}
