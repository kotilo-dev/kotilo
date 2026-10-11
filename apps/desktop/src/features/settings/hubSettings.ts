/**
 * Pure helpers for editing the hub's settings (`GET/PUT /v1/settings`): .NET TimeSpan /
 * TimeOnly conversions and client-side validation, so an invalid value is caught before the
 * whole object is sent back. Field keys are the hub's dotted paths.
 */
import type { HubSettings, TimeOnlyString, TimeSpanString } from "../../lib/hubTypes";
import type { Strings } from "../../app/i18n";

/** `[d.]hh:mm:ss[.fffffff]` → seconds; null when it isn't a TimeSpan. */
export function parseTimeSpan(value: TimeSpanString): number | null {
  const m = /^(-)?(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(value.trim());
  if (!m) return null;
  const seconds = Number(m[2] ?? 0) * 86_400 + Number(m[3]) * 3_600 + Number(m[4]) * 60 + Number(m[5]);
  return m[1] ? -seconds : seconds;
}

/** Seconds → `[d.]hh:mm:ss`; null for a non-finite or negative number. */
export function formatTimeSpan(seconds: number): TimeSpanString | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.round(seconds);
  const days = Math.floor(whole / 86_400);
  const rest = whole % 86_400;
  const pad = (n: number) => String(n).padStart(2, "0");
  const hms = `${pad(Math.floor(rest / 3_600))}:${pad(Math.floor((rest % 3_600) / 60))}:${pad(rest % 60)}`;
  return days > 0 ? `${days}.${hms}` : hms;
}

/** Marker kept in a TimeSpan field while the user's input is not a valid number. */
export const INVALID_TIMESPAN = "invalid";

/** `23:00:00` → `23:00` for `<input type="time">`. */
export function timeOnlyToInput(value: TimeOnlyString): string {
  return value.slice(0, 5);
}

/** `23:00` → `23:00:00`; `HH:mm` only. */
export function inputToTimeOnly(value: string): TimeOnlyString {
  return /^\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
}

export function isTimeOfDay(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value);
}

function inRange(n: number, min: number, max: number): boolean {
  return Number.isFinite(n) && n >= min && n <= max;
}

/** Client-side checks mirroring the hub's own validation. Empty object = valid. */
export function validateHubSettings(s: HubSettings, t: Strings["settingsPage"]): Record<string, string> {
  const errors: Record<string, string> = {};
  const range = (key: string, n: number, min: number, max: number) => {
    if (!inRange(n, min, max)) errors[key] = t.rangeError(min, max);
  };
  const span = (key: string, value: TimeSpanString, minSeconds: number, maxSeconds: number, unit: number) => {
    const seconds = parseTimeSpan(value);
    if (seconds === null || seconds < minSeconds || seconds > maxSeconds) errors[key] = t.rangeError(minSeconds / unit, maxSeconds / unit);
  };

  range("rules.contextThresholdPercent", s.rules.contextThresholdPercent, 1, 100);
  range("rules.contextRearmPercent", s.rules.contextRearmPercent, 0, 99);
  if (!errors["rules.contextThresholdPercent"] && !errors["rules.contextRearmPercent"] && s.rules.contextRearmPercent >= s.rules.contextThresholdPercent) {
    errors["rules.contextRearmPercent"] = t.notifications.rearmBelowThreshold;
  }
  span("rules.reminderAfter", s.rules.reminderAfter, 60, 240 * 60, 60);
  span("rules.minTurnForCompleted", s.rules.minTurnForCompleted, 0, 3_600, 1);
  range("usageRules.dailyCostThresholdUsd", s.usageRules.dailyCostThresholdUsd, 0, 100_000);
  if (!isTimeOfDay(s.quietHours.start)) errors["quietHours.start"] = t.timeError;
  if (!isTimeOfDay(s.quietHours.end)) errors["quietHours.end"] = t.timeError;
  if (s.dictation.hotkey.trim() === "") errors["dictation.hotkey"] = t.dictation.hotkeyRequired;
  if (s.dictation.pasteLastHotkey.trim() === "") errors["dictation.pasteLastHotkey"] = t.dictation.hotkeyRequired;
  if (s.buddy.enabled && s.buddy.hotkey.trim() === "") errors["buddy.hotkey"] = t.dictation.hotkeyRequired;
  range("dictation.maxMinutes", s.dictation.maxMinutes, 1, 60);
  range("insights.uncommittedThreshold", s.insights.uncommittedThreshold, 1, 10_000);
  if (!isTimeOfDay(s.insights.dailySummaryTime)) errors["insights.dailySummaryTime"] = t.timeError;
  return errors;
}

/** Comma/space separated positive integers; null if any part isn't one. */
export function parseNumberList(text: string): number[] | null {
  const parts = text.split(/[\s,;]+/).filter((p) => p !== "");
  const numbers = parts.map(Number);
  return numbers.every((n) => Number.isInteger(n) && n > 0) ? numbers : null;
}

/** ISO timestamp for "do not disturb for 1 hour" / "until tomorrow 09:00 local". */
export function dndUntil(kind: "hour" | "tomorrow", now: Date = new Date()): string {
  if (kind === "hour") return new Date(now.getTime() + 3_600_000).toISOString();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0).toISOString();
}
