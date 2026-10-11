/** Turkish `update` (same shape as `update.en.ts`). */
import { APP_NAME } from "../constants";
import type { updateEn } from "./update.en";

export const updateTr: typeof updateEn = {
  // Hakkında
  license: "Apache Lisansı 2.0 ile ücretsiz ve açık kaynak.",
  linksLabel: "Proje bağlantıları",
  repository: "Kaynak kod",
  issues: "Sorun bildir",
  discussions: "Tartışmalar",
  notAffiliated: `${APP_NAME} bağımsız bir açık kaynak projesidir. Claude Code, Codex, GitHub Copilot CLI, Gemini CLI ve diğer kodlama ajanlarıyla çalışır; bu ajanları geliştiren şirketlerle bir bağı yoktur ve onlar tarafından desteklenmez. Ürün adları sahiplerine aittir.`,
  licensesTitle: "Açık kaynak lisansları",
  licensesShow: "Açık kaynak lisanslarını göster",
  licensesHide: "Açık kaynak lisanslarını gizle",
  licensesSearch: "Lisanslarda ara",
  licensesSearchPlaceholder: "Paket ya da lisansa göre süz…",
  licensesMatches: (n: number) => `${n} eşleşen satır`,
  licensesLoading: "Lisanslar yükleniyor…",
  licensesError: "Lisans listesi yüklenemedi.",

  // Denetim
  checkOnStart: "Açılışta güncellemeleri denetle",
  checkNow: "Güncellemeleri denetle",
  checking: "Güncellemeler denetleniyor…",
  upToDate: (version: string) => `Güncelsiniz (sürüm ${version}).`,
  available: (version: string) => `${version} sürümü hazır.`,
  notConfigured: "Bu derlemede güncellemeler yapılandırılmamış.",
  checkFailed: (message: string) => `Güncellemeler denetlenemedi: ${message}`,

  // Bildirim
  promptLabel: "Güncelleme hazır",
  promptTitle: (version: string) => `${APP_NAME} ${version} hazır`,
  promptCurrent: (current: string, date: string | null) => `Yüklü sürüm ${current}${date ? ` · yayın tarihi ${date}` : ""}`,
  notesLabel: "Yenilikler",
  install: "Yükle ve yeniden başlat",
  later: "Sonra",
  downloading: (percent: number | null) => (percent === null ? "İndiriliyor…" : `İndiriliyor… %${percent}`),
  downloadedSize: (downloaded: string, total: string | null) => (total ? `${downloaded} / ${total}` : downloaded),
  progressLabel: "İndirme ilerlemesi",
  ready: "Yükleniyor – uygulama birazdan yeniden başlayacak.",
  installFailed: (message: string) => `Güncelleme yüklenemedi: ${message}`,
  retry: "Yeniden dene",
  close: "Kapat",
};
