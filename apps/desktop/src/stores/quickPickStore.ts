/**
 * QuickPick açık/kapalı durumu + girdi metni (faz6-spec §5). Yalnızca bu ikisini tutar — mod
 * (dosya/komut) girdi metninden türetilir (bkz. `quickPickLogic.ts`). `commands.ts`'in
 * `run()` callback'leri (React dışı) buradan `openFile`/`openCommand`/`close` çağırır; bu yüzden
 * zustand store (herhangi bir yerden `getState()` ile erişilebilir).
 *
 * İdempotentlik (§10.7): kısayola tekrar basmak zaten açıksa yalnızca modu değiştirir (veya
 * aynı moddaysa no-op) — yeniden açıp girdiyi sıfırlamaz gereksiz yere.
 */
import { create } from "zustand";

interface QuickPickStore {
  open: boolean;
  input: string;
  /** Açılmadan önce odaklı olan eleman — kapanınca odak buna döner (§5). */
  previouslyFocused: HTMLElement | null;

  openFile: () => void;
  openCommand: () => void;
  setInput: (value: string) => void;
  close: () => void;
}

export const useQuickPickStore = create<QuickPickStore>((set, get) => ({
  open: false,
  input: "",
  previouslyFocused: null,

  openFile: () => {
    const s = get();
    if (s.open && !s.input.startsWith(">")) return; // zaten dosya modunda — no-op
    set({
      open: true,
      input: "",
      previouslyFocused: s.open ? s.previouslyFocused : (document.activeElement as HTMLElement | null),
    });
  },

  openCommand: () => {
    const s = get();
    if (s.open && s.input.startsWith(">")) return; // zaten komut modunda — no-op
    set({
      open: true,
      input: ">",
      previouslyFocused: s.open ? s.previouslyFocused : (document.activeElement as HTMLElement | null),
    });
  },

  setInput: (value) => set({ input: value }),

  close: () => {
    const { previouslyFocused } = get();
    set({ open: false, input: "", previouslyFocused: null });
    previouslyFocused?.focus?.();
  },
}));
