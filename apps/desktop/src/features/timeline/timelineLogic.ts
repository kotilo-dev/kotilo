/**
 * M4 timeline rail (DESIGN_SYSTEM §7.7): pure helpers for the activity ring, the plan, the
 * changed-files grouping and which hub session the rail follows. No IO; the stores call these.
 */
import type {
  ActivityDto,
  ActivityEntry,
  ActivityFrame,
  ActivityPlan,
  ActivityToolEntry,
  SessionDto,
} from "../../lib/hubTypes";
import type { Agent, GitChangedFile } from "../../lib/ipc";
import { matchSession } from "../workspace/paneSession";

/** The hub keeps the last 200 entries per session; the rail mirrors that. */
export const ACTIVITY_RING = 200;

export interface SessionRef {
  agent: string;
  sessionId: string;
}

export function sessionKey(ref: SessionRef): string {
  return `${ref.agent}/${ref.sessionId}`;
}

export interface SessionActivity {
  entries: ActivityEntry[];
  plan: ActivityPlan | null;
}

export const EMPTY_ACTIVITY: SessionActivity = { entries: [], plan: null };

export function isToolEntry(entry: ActivityEntry): entry is ActivityToolEntry {
  return entry.kind !== "turn";
}

/**
 * Merges `incoming` into `current` by `id` (ids ascend across the hub), oldest first, keeping
 * the last `ACTIVITY_RING`. A finished entry is never turned back into "running" (an older
 * full fetch can arrive after a newer stream delta).
 */
export function mergeEntries(current: readonly ActivityEntry[], incoming: readonly ActivityEntry[]): ActivityEntry[] {
  if (incoming.length === 0) return current as ActivityEntry[];
  const byId = new Map<number, ActivityEntry>();
  for (const e of current) byId.set(e.id, e);
  for (const e of incoming) {
    const prev = byId.get(e.id);
    if (prev && isToolEntry(prev) && isToolEntry(e) && prev.status !== "running" && e.status === "running") continue;
    byId.set(e.id, e);
  }
  const merged = [...byId.values()].sort((a, b) => a.id - b.id);
  return merged.length > ACTIVITY_RING ? merged.slice(merged.length - ACTIVITY_RING) : merged;
}

/** A stream `activity` delta: entries merged, the plan replaced (the frame always carries the current plan). */
export function applyFrame(current: SessionActivity, frame: ActivityFrame): SessionActivity {
  return { entries: mergeEntries(current.entries, frame.entries), plan: frame.plan };
}

/**
 * A full `GET …/activity` answer. `planFromStream`: a stream frame arrived while the request
 * was in flight, so its plan is at least as new as the response's.
 */
export function applySnapshot(current: SessionActivity, dto: ActivityDto, planFromStream: boolean): SessionActivity {
  return { entries: mergeEntries(current.entries, dto.entries), plan: planFromStream ? current.plan : dto.plan };
}

// ---------------------------------------------------------------------------
// Plan

export interface PlanProgress {
  done: number;
  total: number;
  /** 0–100. */
  percent: number;
}

export function planProgress(plan: ActivityPlan | null): PlanProgress | null {
  if (!plan || plan.items.length === 0) return null;
  const done = plan.items.filter((i) => i.status === "completed").length;
  return { done, total: plan.items.length, percent: Math.round((done / plan.items.length) * 100) };
}

// ---------------------------------------------------------------------------
// Activity rows

/** DESIGN_SYSTEM §5: R (Read), E (Edit/Write), B (Bash), W (Web), T (Task); S search, M MCP, • other. */
export function toolLetter(entry: ActivityToolEntry): string {
  switch (entry.kind) {
    case "read":
      return "R";
    case "edit":
    case "write":
      return "E";
    case "bash":
      return "B";
    case "task":
      return "T";
    case "search":
      return /web|fetch|url|browse/i.test(entry.tool) ? "W" : "S";
    case "other":
      return entry.tool.startsWith("mcp__") ? "M" : "•";
  }
}

/** Colour family of the letter icon: running amber, failed/denied red, edits accent, the rest neutral. */
export type ToolTone = "running" | "failed" | "edit" | "neutral";

export function toolTone(entry: ActivityToolEntry): ToolTone {
  if (entry.status === "running") return "running";
  if (entry.status === "failed" || entry.status === "denied") return "failed";
  if (entry.kind === "edit" || entry.kind === "write") return "edit";
  return "neutral";
}

/** `320 ms`, `4.2 s`, `1m 05s`. */
export function formatToolDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Entries newest first, as the rail lists them. */
export function newestFirst(entries: readonly ActivityEntry[]): ActivityEntry[] {
  return [...entries].reverse();
}

// ---------------------------------------------------------------------------
// Changed files

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isAbsolute(path: string): boolean {
  return /^[a-zA-Z]:\//.test(path) || path.startsWith("/");
}

/** `path` relative to `root` (both normalized), or null when it is outside. Case-insensitive (Windows). */
function relativeTo(path: string, root: string): string | null {
  const p = normalizePath(path);
  const r = normalizePath(root);
  if (r === "") return null;
  if (p.toLowerCase() === r.toLowerCase()) return "";
  if (!p.toLowerCase().startsWith(r.toLowerCase() + "/")) return null;
  return p.slice(r.length + 1);
}

/**
 * Workspace-relative paths (lower-cased) that the agent edited or wrote, from `target` and
 * `paths` of edit/write entries. Hub targets are relative to the session's project root, or
 * absolute when outside it.
 */
export function touchedPaths(
  entries: readonly ActivityEntry[],
  workspacePath: string,
  projectRoot: string | null,
): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    if (!isToolEntry(e) || (e.kind !== "edit" && e.kind !== "write")) continue;
    const candidates = [...(e.target ? [e.target] : []), ...(e.paths ?? [])];
    for (const raw of candidates) {
      const p = normalizePath(raw.trim());
      if (p === "") continue;
      const absolute = isAbsolute(p) ? p : projectRoot ? `${normalizePath(projectRoot)}/${p}` : null;
      const rel = absolute ? relativeTo(absolute, workspacePath) : p;
      if (rel) out.add(rel.toLowerCase());
    }
  }
  return out;
}

export interface ChangedFileGroups {
  touched: GitChangedFile[];
  other: GitChangedFile[];
}

/** Files the agent touched first (both keep git's path order); renames match by either path. */
export function groupChangedFiles(files: readonly GitChangedFile[], touched: ReadonlySet<string>): ChangedFileGroups {
  const groups: ChangedFileGroups = { touched: [], other: [] };
  for (const f of files) {
    const hit = touched.has(f.path.toLowerCase()) || (f.oldPath !== undefined && touched.has(f.oldPath.toLowerCase()));
    (hit ? groups.touched : groups.other).push(f);
  }
  return groups;
}

export function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/** The folder part of a workspace-relative path (`""` at the root). */
export function dirNameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

// ---------------------------------------------------------------------------
// Which session the rail follows

/**
 * The session of the active terminal tab (pane id, else the desktop record's session id); without
 * one, the most recently active live session whose project is the workspace folder.
 */
export function selectTimelineSession(
  sessions: readonly SessionDto[],
  agents: readonly Agent[],
  activePaneId: string | null,
  workspacePath: string | null,
): SessionDto | null {
  if (activePaneId) {
    const agent = agents.find((a) => a.paneId === activePaneId);
    const byPane = matchSession(sessions, activePaneId, agent);
    if (byPane) return byPane;
  }
  if (!workspacePath) return null;
  return (
    sessions
      .filter((s) => s.state !== "Ended" && relativeTo(s.projectRoot, workspacePath) === "")
      .sort((a, b) => Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt))[0] ?? null
  );
}
