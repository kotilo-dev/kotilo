/**
 * Shared frontend logging primitives (faz7-spec.md §9.3, §9.5): a tiny error serializer plus a
 * flood guard that both `frontendErrors.ts` (window `error`/`unhandledrejection`) and `ipc.ts`
 * (central IPC failure logging) go through — "aynı sel önleme" (§9.5) means the same guard
 * instance, not a re-implementation per call site.
 *
 * Deliberately does NOT import from `ipc.ts` (which itself imports `logWarn` from here) — a
 * tiny local structural check replaces `isAppError` to avoid a circular module dependency.
 */
import { error as pluginError, warn as pluginWarn } from "@tauri-apps/plugin-log";

declare global {
  interface Window {
    /** Set by `ErrorBoundary`/`main.tsx` once a crash has been caught this session. */
    __agenthubCrashed?: boolean;
  }
}

const DEDUPE_WINDOW_MS = 5000;
/** §9.3: after the boundary has fired, cap the whole session at 100 frontend log lines. */
const POST_CRASH_LINE_LIMIT = 100;
/**
 * `lastLoggedAt` never removes an entry on its own (dedupe needs to remember "have I ever
 * logged this exact message"), so a long session logging many distinct messages would
 * otherwise grow this map forever. Once it crosses this many entries, prune everything
 * already outside the dedupe window — cheap (an O(n) sweep) and rare (only past 500
 * distinct messages), and never drops an entry still within its dedupe window.
 */
const PRUNE_MAP_SIZE_THRESHOLD = 500;

let lastLoggedAt = new Map<string, number>();
let postCrashLineCount = 0;

function pruneStaleDedupeEntries(now: number): void {
  for (const [message, loggedAt] of lastLoggedAt) {
    if (now - loggedAt >= DEDUPE_WINDOW_MS) {
      lastLoggedAt.delete(message);
    }
  }
}

function isAppErrorLike(e: unknown): e is { code: string; message: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as Record<string, unknown>).code === "string" &&
    typeof (e as Record<string, unknown>).message === "string"
  );
}

/** AppError -> `code: message`; Error -> `name: message` + first 10 stack lines; else JSON (500 chars). */
export function serializeError(e: unknown): string {
  if (isAppErrorLike(e)) return `${e.code}: ${e.message}`;
  if (e instanceof Error) {
    const stackLines = e.stack ? e.stack.split("\n").slice(0, 10).join("\n") : "";
    return stackLines ? `${e.name}: ${e.message}\n${stackLines}` : `${e.name}: ${e.message}`;
  }
  try {
    return JSON.stringify(e).slice(0, 500);
  } catch {
    return String(e).slice(0, 500);
  }
}

/** Single-line variant for on-screen display (recovery screen): no stack, no truncation games. */
export function oneLineMessage(e: unknown): string {
  if (isAppErrorLike(e)) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e).slice(0, 200);
}

function shouldLog(message: string): boolean {
  const now = Date.now();
  const last = lastLoggedAt.get(message);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return false;
  lastLoggedAt.set(message, now);
  if (lastLoggedAt.size > PRUNE_MAP_SIZE_THRESHOLD) pruneStaleDedupeEntries(now);

  if (typeof window !== "undefined" && window.__agenthubCrashed) {
    postCrashLineCount += 1;
    if (postCrashLineCount > POST_CRASH_LINE_LIMIT) return false;
  }
  return true;
}

/** Fire-and-forget `warn` through `@tauri-apps/plugin-log`, deduped/capped by the flood guard. */
export function logWarn(message: string): void {
  if (!shouldLog(message)) return;
  void pluginWarn(message).catch(() => {});
}

/** Fire-and-forget `error` through `@tauri-apps/plugin-log`, deduped/capped by the flood guard. */
export function logError(message: string): void {
  if (!shouldLog(message)) return;
  void pluginError(message).catch(() => {});
}

/** Tests only: clears the module-level dedupe map and post-crash counter between cases. */
export function resetLoggingForTest(): void {
  lastLoggedAt = new Map();
  postCrashLineCount = 0;
}

/** Tests only: the dedupe map's current entry count (asserts pruning actually shrinks it). */
export function dedupeMapSizeForTest(): number {
  return lastLoggedAt.size;
}
