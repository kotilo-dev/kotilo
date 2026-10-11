/**
 * Pure helpers for the Tasks screen (CCC spec §21.2): grouping, quick due dates, relative
 * times. Ordering inside a group is the hub's (overdue → due date → priority → newest).
 */
import { currentLocale } from "../../app/i18n";
import type { PersonalTask } from "../../lib/hubTypes";

export interface TaskGroup {
  /** Null = "General notes". */
  projectRoot: string | null;
  projectName: string | null;
  tasks: PersonalTask[];
}

/** General notes first, then one group per project (in order of first appearance). */
export function groupTasks(tasks: readonly PersonalTask[]): TaskGroup[] {
  const general: TaskGroup = { projectRoot: null, projectName: null, tasks: [] };
  const byProject = new Map<string, TaskGroup>();
  for (const task of tasks) {
    if (!task.projectRoot) {
      general.tasks.push(task);
      continue;
    }
    let group = byProject.get(task.projectRoot);
    if (!group) {
      group = { projectRoot: task.projectRoot, projectName: task.projectName, tasks: [] };
      byProject.set(task.projectRoot, group);
    }
    group.tasks.push(task);
  }
  return [...(general.tasks.length > 0 ? [general] : []), ...byProject.values()];
}

/** Local `yyyy-MM-dd` for `today + days`. */
export function isoDatePlusDays(days: number, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** First line = title, the rest = details (spec §21.1). */
export function splitNote(text: string): { title: string; details: string } {
  const trimmed = text.trim();
  const newline = trimmed.indexOf("\n");
  if (newline < 0) return { title: trimmed, details: "" };
  return { title: trimmed.slice(0, newline).trim(), details: trimmed.slice(newline + 1).trim() };
}

/** "3 minutes ago", "in 2 days" in the active UI language. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const diffSeconds = (new Date(iso).getTime() - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat(currentLocale(), { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, seconds] of units) {
    if (Math.abs(diffSeconds) >= seconds) return rtf.format(Math.round(diffSeconds / seconds), unit);
  }
  return rtf.format(Math.round(diffSeconds), "second");
}

/** Due chip text: the date (and time) in the UI locale. */
export function formatDue(task: Pick<PersonalTask, "dueDate" | "dueTime">): string | null {
  if (!task.dueDate) return null;
  const [y, m, d] = task.dueDate.split("-").map(Number);
  const date = new Date(y!, (m ?? 1) - 1, d ?? 1);
  const day = new Intl.DateTimeFormat(currentLocale(), { day: "numeric", month: "short", weekday: "short" }).format(date);
  return task.dueTime ? `${day} ${task.dueTime}` : day;
}
