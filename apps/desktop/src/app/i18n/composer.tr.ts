/** Turkish `composer` (same shape as `composer.en.ts`). */
import { APP_SLUG } from "../constants";
import type { composerEn } from "./composer.en";

export const composerTr: typeof composerEn = {
  region: (agent: string) => `${agent} için mesaj`,
  placeholder: "Ajana yaz… dosya anmak için @",
  hint: "Enter: gönder · Shift+Enter: yeni satır",
  send: "Gönder (Enter)",
  dictate: "Mesaja dikte et",
  stopDictation: "Dikteyi bitir",
  transcribing: "Yazıya dökülüyor…",
  files: "Dosyalar",
  noMatches: "Eşleşen dosya yok",
  removeAttachment: (path: string) => `${path} kaldır`,
  attachingImage: "Görsel kaydediliyor…",
  imageFailed: (message: string) => `Görsel eklenemedi: ${message}`,
  attachmentsHint: `Yapıştırılan görseller .${APP_SLUG}/attachments/ klasörüne kaydedilir. Commit'lenmemeleri için .${APP_SLUG}/ satırını .gitignore dosyanıza ekleyin.`,
  gotIt: "Anladım",
  sendFailed: (message: string) => `Gönderilemedi: ${message}`,
  savedPrompts: "Kayıtlı istemler",
  savePrompt: "Mesajı istem olarak kaydet",
  promptSaved: (title: string) => `“${title}” istemi kaydedildi`,
  promptsEmpty: "Henüz kayıtlı istem yok. Bir mesaj yazıp tekrar kullanmak için buraya kaydedin.",
  filterPrompts: "İstemleri filtrele",
  deletePrompt: (title: string) => `“${title}” sil`,
  split: {
    splitRight: "Sağa böl",
    closeSplit: "Bölmeyi kapat",
    closeHalf: (title: string) => `Bölmeyi kapat (“${title}” sekme olarak kalır)`,
    dropRight: "Sağda açmak için buraya bırakın",
  },
};
