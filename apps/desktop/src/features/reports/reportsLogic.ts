/** Pure helpers for the Reports screen (unit-tested). */
import type { CostGrouping } from "../../lib/hubTypes";
import { APP_SLUG } from "../../app/constants";
import { toIsoDate } from "../../app/ui/format";

export type ExportFormat = "csv" | "xlsx";

/** The default cost range: the last 30 days ending today (local, inclusive). */
export function defaultCostRange(today: Date = new Date()): { from: string; to: string } {
  const from = new Date(today);
  from.setDate(from.getDate() - 29);
  return { from: toIsoDate(from), to: toIsoDate(today) };
}

export function costPath(from: string, to: string, groupBy: CostGrouping, format?: ExportFormat, lang?: string): string {
  const q = new URLSearchParams({ from, to, groupBy });
  if (format) q.set("format", format);
  if (lang) q.set("lang", lang);
  return `/v1/reports/cost?${q.toString()}`;
}

/** File name suggested by the save dialog. */
export function exportFileName(from: string, to: string, format: ExportFormat): string {
  return `${APP_SLUG}-cost-${from}_${to}.${format}`;
}

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}
