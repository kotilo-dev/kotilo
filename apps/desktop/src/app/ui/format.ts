/**
 * Number/time formats shared by the data screens (DESIGN_SYSTEM §10): `312k`, `1.24 M`,
 * `$4.82`, `2m 14s`, `41%`; missing data is "—", never invented.
 */
import { formatCurrencyUsd, formatDateTime, formatNumber, formatTokens } from "../i18n";

export const NO_VALUE = "—";

/** Cost, or "—" when unknown or when the total includes unpriced usage (e.g. Codex without pricing). */
export function formatCost(value: number | null | undefined, hasUnpriced = false): string {
  if (value === null || value === undefined || Number.isNaN(value)) return NO_VALUE;
  if (hasUnpriced && value === 0) return NO_VALUE;
  return formatCurrencyUsd(value);
}

export function formatTokenCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return NO_VALUE;
  return formatTokens(value);
}

/** Whole percent from a 0–100 value. */
export function formatPercent100(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return NO_VALUE;
  return `${formatNumber(Math.round(value))}%`;
}

/** `45s`, `2m 14s`, `1h 05m`, `3d 4h`. */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || Number.isNaN(totalSeconds)) return NO_VALUE;
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Seconds from an ISO timestamp until `now` (never negative). */
export function secondsSince(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, (now - t) / 1000);
}

/** Local `HH:mm` (today) or a short date + time otherwise. */
export function formatClock(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return NO_VALUE;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NO_VALUE;
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? formatDateTime(d, { hour: "2-digit", minute: "2-digit" })
    : formatDateTime(d, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** Short local date from `yyyy-MM-dd` (no timezone shift). */
export function formatIsoDate(date: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return formatDateTime(new Date(y, m - 1, d), options);
}

/** `yyyy-MM-dd` for a local date. */
export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Compact currency for chart axes (`$0`, `$2.5`, `$40`). */
export function formatCurrencyCompact(value: number): string {
  return `$${formatNumber(value, { maximumFractionDigits: value < 10 ? 1 : 0 })}`;
}
