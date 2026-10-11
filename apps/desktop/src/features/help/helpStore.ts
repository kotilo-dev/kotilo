/**
 * Help modal open/active-doc/scroll state (faz7-spec §10.2–§10.3, §12.8). Zustand so `commands.ts`
 * `run()` callbacks (F1, palette entries, Settings → About "Open help" — all React-external) can
 * open it. "Last viewed doc" is kept in a module-level variable, NOT persisted (§10.3: "in memory
 * only") — it survives close/reopen within the session but resets on reload, same lifetime as
 * this whole module.
 */
import { create } from "zustand";
import { isOtherModalOpen } from "../../app/modalStack";
import { type HelpDocId } from "./helpDocs";

export type HelpItem = HelpDocId | "about";

const DEFAULT_DOC: HelpDocId = "user-guide.md";
let lastViewedDoc: HelpDocId = DEFAULT_DOC;

interface HelpStore {
  open: boolean;
  item: HelpItem;
  /** Anchor to scroll to once the target doc's content has (re-)rendered — cleared after use. */
  pendingAnchor: string | null;
  previouslyFocused: HTMLElement | null;

  /** Idempotent (already-open → no-op, matching `settingsModalStore`'s pattern). */
  openHelp: (item?: HelpItem) => void;
  /** Cross-doc link navigation (§12.7/§12.8): switch doc/item and remember an anchor to scroll to. */
  openItemWithAnchor: (item: HelpItem, hash: string) => void;
  setItem: (item: HelpItem) => void;
  clearPendingAnchor: () => void;
  close: () => void;
}

export const useHelpStore = create<HelpStore>((set, get) => ({
  open: false,
  item: DEFAULT_DOC,
  pendingAnchor: null,
  previouslyFocused: null,

  openHelp: (item) => {
    if (get().open) return;
    const target = item ?? lastViewedDoc;
    if (target !== "about") lastViewedDoc = target;
    set({ open: true, item: target, pendingAnchor: null, previouslyFocused: document.activeElement as HTMLElement | null });
  },

  openItemWithAnchor: (item, hash) => {
    if (item !== "about") lastViewedDoc = item;
    set((s) => ({
      open: true,
      item,
      pendingAnchor: hash || null,
      previouslyFocused: s.open ? s.previouslyFocused : (document.activeElement as HTMLElement | null),
    }));
  },

  setItem: (item) => {
    if (item !== "about") lastViewedDoc = item;
    set({ item, pendingAnchor: null });
  },

  clearPendingAnchor: () => set({ pendingAnchor: null }),

  close: () => {
    const { previouslyFocused } = get();
    set({ open: false, previouslyFocused: null });
    previouslyFocused?.focus?.();
  },
}));

/** Test-only: `lastViewedDoc` is module state, invisible to `useHelpStore.setState`. */
export function resetHelpMemoryForTest(): void {
  lastViewedDoc = DEFAULT_DOC;
}

/**
 * The F1 global shortcut's own logic (faz7-spec §12.4), factored out of `App.tsx`'s command
 * registration so it's unit-testable on its own: no-op while any OTHER modal is open
 * (`modalStack`) or while Help itself is already open; otherwise opens on the last viewed doc.
 */
export function openHelpFromF1(): void {
  if (isOtherModalOpen() || useHelpStore.getState().open) return;
  useHelpStore.getState().openHelp();
}
