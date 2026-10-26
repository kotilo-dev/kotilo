/** D-069: `quickCommands.en.ts` in Turkish. */
import type { quickCommandsEn } from "./quickCommands.en";

export const quickCommandsTr: typeof quickCommandsEn = {
  button: "Hızlı komutlar",
  commandsGroup: "Komutlar",
  promptsGroup: "İstemler",
  manage: "Hızlı komutları yönet…",
  empty: "Henüz hızlı komut yok.",
  noAgent: "Bu çalışma alanında istemi alacak çalışan bir ajan yok.",
  intro:
    "Kabuk komutları geçerli terminale yazılır (orada bir ajan çalışıyorsa yeni bir sekmede başlar). İstemler bir ajanın mesaj alanına konur, siz gönderirsiniz. Mesaj alanından kaydedilen istemler de burada görünür.",
  add: "Ekle",
  edit: "Düzenle",
  delete: "Sil",
  save: "Kaydet",
  cancel: "Vazgeç",
  kind: "Tür",
  kindCommand: "Kabuk komutu",
  kindPrompt: "Ajan istemi",
  title: "Ad",
  titlePlaceholder: "Menüde ve komut paletinde görünür",
  command: "Komut",
  commandPlaceholder: "npm test",
  prompt: "İstem",
  promptPlaceholder: "Commit edilmemiş değişiklikleri incele ve riskli yerleri listele.",
  scope: "Nerede kullanılabilir",
  scopeAll: "Tüm çalışma alanları",
  scopeMissing: (path: string) => `${path} (açık değil)`,
  listLabel: "Hızlı komutlar",
  textRequired: "Komut ya da istem metnini girin.",
};
