/**
 * Basit sağ-alt toast bildirimleri (faz2-spec §6 "Toast"). İleride başka fazlarda da
 * kullanılacağı düşünülerek genel bir isim taşıyor (`notificationStore` yerine
 * `toastStore` — işlevsel olarak aynı, tek tüketici bugün için `ToastHost`).
 */
import { create } from "zustand";

export interface Toast {
  id: number;
  message: string;
}

interface ToastStore {
  toasts: Toast[];
  show: (message: string) => void;
  dismiss: (id: number) => void;
}

const TOAST_DURATION_MS = 3000;
let nextId = 1;

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],

  show: (message) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message }] }));
    setTimeout(() => get().dismiss(id), TOAST_DURATION_MS);
  },

  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
