/**
 * M6: the hub settings the mascot needs (buddy, DND / quiet hours, the "completed" threshold),
 * kept app-wide. Mascot settings are saved at once and only touch `buddy`: each save reads the
 * hub's current settings and sends them back with the buddy change, so an unsaved draft on the
 * Settings page is never sent along. The Settings page copies `buddy` into its draft and base
 * (`SettingsPage.tsx`) and reports its own saves here (`setFromHub`).
 */
import { create } from "zustand";
import { strings } from "../../app/strings";
import { hubRequest } from "../../lib/ipc";
import type { BuddySettings, HubSettings } from "../../lib/hubTypes";
import { useToastStore } from "../../stores/toastStore";
import { asAppError } from "./hubData";

interface MascotSettingsState {
  settings: HubSettings | null;
  /** The one-time "turn on the mascot" card is showing. */
  offerVisible: boolean;
  load: () => Promise<void>;
  setFromHub: (settings: HubSettings) => void;
  /** Saves a buddy change at once (optimistic; reverted to the hub's state on failure). */
  saveBuddy: (change: (buddy: BuddySettings) => BuddySettings) => Promise<void>;
  showOffer: () => void;
  answerOffer: (turnOn: boolean) => Promise<void>;
}

// Saves run one after another, so two quick changes (drag, then "hide") can't overwrite each other.
let queue: Promise<void> = Promise.resolve();

export const useMascotSettingsStore = create<MascotSettingsState>((set, get) => ({
  settings: null,
  offerVisible: false,

  load: async () => {
    try {
      set({ settings: await hubRequest<HubSettings>("GET", "/v1/settings") });
    } catch {
      // Hub not running: keep what we had; the bridge reloads on reconnect.
    }
  },

  setFromHub: (settings) => set({ settings }),

  saveBuddy: (change) => {
    const current = get().settings;
    if (current) set({ settings: { ...current, buddy: change(current.buddy) } });
    const run = queue.then(async () => {
      try {
        const fresh = await hubRequest<HubSettings>("GET", "/v1/settings");
        const next = { ...fresh, buddy: change(fresh.buddy) };
        const saved = await hubRequest<HubSettings | null>("PUT", "/v1/settings", next);
        set({ settings: saved ?? next });
      } catch (e) {
        useToastStore.getState().show(strings.mascot.saveFailed(asAppError(e).message));
        await get().load();
      }
    });
    queue = run;
    return run;
  },

  showOffer: () => {
    if (!get().offerVisible) set({ offerVisible: true });
  },

  answerOffer: async (turnOn) => {
    set({ offerVisible: false });
    await get().saveBuddy((b) => ({ ...b, mascotOffered: true, mascotEnabled: turnOn ? true : b.mascotEnabled }));
  },
}));
