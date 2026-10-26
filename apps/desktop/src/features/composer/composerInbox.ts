/**
 * Text handed to a pane's composer from elsewhere in the app (D-066: review notes). The
 * composer takes it when it is mounted, puts it into its field and focuses it; the user reads
 * and sends it – nothing is typed into the agent without that.
 */
import { create } from "zustand";

interface ComposerInbox {
  pending: Record<string, string>;
  deliver: (paneId: string, text: string) => void;
  /** Returns and clears the text waiting for `paneId`. */
  take: (paneId: string) => string | null;
}

export const useComposerInbox = create<ComposerInbox>((set, get) => ({
  pending: {},
  deliver: (paneId, text) => set((s) => ({ pending: { ...s.pending, [paneId]: text } })),
  take: (paneId) => {
    const text = get().pending[paneId];
    if (text === undefined) return null;
    set((s) => {
      const rest = { ...s.pending };
      delete rest[paneId];
      return { pending: rest };
    });
    return text;
  },
}));
