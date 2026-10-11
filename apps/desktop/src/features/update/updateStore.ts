/**
 * App updates (M5, D-047): one shared store for the About section's "Check for updates" and the
 * non-blocking update prompt. `update_check` / `update_install` come from Rust (tauri-plugin-
 * updater fed by the public repo's GitHub Releases); nothing here crashes the app – every
 * failure ends in an `error` state that the UI shows.
 */
import { create } from "zustand";
import {
  onUpdateProgress,
  onUpdateReady,
  toAppError,
  updateCheck,
  updateInstall,
  type UpdateCheckResult,
} from "../../lib/ipc";
import { logWarn } from "../../lib/logging";
import { useSettingsStore } from "../../stores/settingsStore";

/** Delay after launch before the automatic check, so it never competes with startup work. */
export const STARTUP_CHECK_DELAY_MS = 4000;

export type CheckState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "done"; result: UpdateCheckResult };

export type InstallState =
  | { phase: "idle" }
  | { phase: "downloading"; downloaded: number; total: number | null }
  | { phase: "ready" }
  | { phase: "error"; message: string };

export type AvailableUpdate = Extract<UpdateCheckResult, { status: "available" }>;

interface UpdateStore {
  check: CheckState;
  install: InstallState;
  /** The update the prompt offers; set by a check that found one, cleared by "Later". */
  prompt: AvailableUpdate | null;

  /** Manual check (About): every result is kept for display; an available update opens the prompt. */
  checkNow: () => Promise<UpdateCheckResult>;
  /** Startup check: silent unless an update is available. */
  checkOnStart: () => Promise<void>;
  installUpdate: () => Promise<void>;
  dismissPrompt: () => void;
}

let checking: Promise<UpdateCheckResult> | null = null;

async function runCheck(): Promise<UpdateCheckResult> {
  try {
    return await updateCheck();
  } catch (e) {
    return { status: "error", message: toAppError(e).message };
  }
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  check: { phase: "idle" },
  install: { phase: "idle" },
  prompt: null,

  checkNow: () => {
    // A second click while a check runs joins it instead of starting another request.
    if (checking) return checking;
    set({ check: { phase: "checking" } });
    checking = runCheck().then((result) => {
      checking = null;
      set({ check: { phase: "done", result } });
      if (result.status === "available") set({ prompt: result });
      return result;
    });
    return checking;
  },

  checkOnStart: async () => {
    const result = await runCheck();
    // A manual check that started meanwhile owns the visible state.
    if (get().check.phase === "idle") set({ check: { phase: "done", result } });
    if (result.status === "available") set({ prompt: result });
    else if (result.status === "error") logWarn(`[update] startup check failed: ${result.message}`);
  },

  installUpdate: async () => {
    const phase = get().install.phase;
    if (phase === "downloading" || phase === "ready") return;
    set({ install: { phase: "downloading", downloaded: 0, total: null } });
    const unlisten = await Promise.all([
      onUpdateProgress(({ downloaded, total }) => {
        if (get().install.phase === "downloading") set({ install: { phase: "downloading", downloaded, total } });
      }),
      onUpdateReady(() => set({ install: { phase: "ready" } })),
    ]).catch(() => [] as (() => void)[]);
    try {
      await updateInstall();
      // The app normally restarts before this resolves; if it does not, show "restarting".
      set({ install: { phase: "ready" } });
    } catch (e) {
      const message = toAppError(e).message;
      logWarn(`[update] install failed: ${message}`);
      set({ install: { phase: "error", message } });
    } finally {
      for (const fn of unlisten) fn();
    }
  },

  dismissPrompt: () => {
    if (get().install.phase === "downloading") return;
    set({ prompt: null, install: { phase: "idle" } });
  },
}));

/** "Check for updates on start" (Settings → About); missing in older settings means on. */
export function checkOnStartEnabled(): boolean {
  return useSettingsStore.getState().settings.updates?.checkOnStart !== false;
}

/**
 * Schedules the one automatic check after launch (App mount). Returns a cleanup that cancels
 * it when it has not run yet.
 */
export function scheduleStartupUpdateCheck(delayMs = STARTUP_CHECK_DELAY_MS): () => void {
  const timer = setTimeout(() => {
    if (checkOnStartEnabled()) void useUpdateStore.getState().checkOnStart();
  }, delayMs);
  return () => clearTimeout(timer);
}

/** Test cleanup. */
export function resetUpdateStoreForTest(): void {
  checking = null;
  useUpdateStore.setState({ check: { phase: "idle" }, install: { phase: "idle" }, prompt: null });
}
