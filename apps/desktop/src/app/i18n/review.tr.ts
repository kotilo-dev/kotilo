/** Turkish `review` (same shape as `review.en.ts`). */
import type { reviewEn } from "./review.en";

export const reviewTr: typeof reviewEn = {
  addNote: "İnceleme notu ekle",
  addNoteAt: (lines: string) => `${lines}. satıra inceleme notu ekle`,
  placeholder: "Ajan burada neyi değiştirmeli? (Enter kaydeder, Shift+Enter yeni satır, Esc vazgeçer)",
  save: "Kaydet",
  cancel: "Vazgeç",
  edit: "Düzenle",
  delete: "Sil",
  resolve: "Çözüldü",
  reopen: "Yeniden aç",
  lines: (lines: string) => `Satır ${lines}`,
  outdated: "Satırlar değişti",
  resolved: "Çözüldü",
  noteCount: (n: number) => `${n} not`,
  sendTo: (n: number) => `${n} notu gönder…`,
  noAgent: "Bu çalışma alanında çalışan bir ajan yok.",
  sentTo: (agent: string) => `Notlar ${agent} mesaj alanına kondu. Kontrol edip gönderin.`,
  hint: "Notu eklemek için satırın üzerine gelip + işaretine tıklayın (ya da satırları seçip C'ye basın).",
};
