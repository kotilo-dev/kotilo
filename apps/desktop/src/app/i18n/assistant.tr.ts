/** Turkish `assistant` (same shape as `assistant.en.ts`). */
import { APP_NAME } from "../constants";
import type { assistantEn } from "./assistant.en";

export const assistantTr: typeof assistantEn = {
  // Pencere başlığı
  title: "Asistan",
  providerModel: (provider: string, model: string | null) => (model ? `${provider} · ${model}` : provider),
  newChat: "Yeni sohbet",
  close: "Kapat",
  // Mesajlar
  emptyTitle: "Aklınızdakini sorun",
  emptyHint: "Hızlı sorular için küçük, genel amaçlı bir sohbet. Oturumlarınızı, dosyalarınızı ya da kullanımınızı görmez.",
  messagesLabel: "Sohbet",
  you: "Siz",
  answer: "Yanıt",
  typing: "Yazıyor…",
  stopped: "Durduruldu.",
  copyAnswer: "Yanıtı kopyala",
  copyCode: "Kodu kopyala",
  copied: "Kopyalandı",
  // Yazma alanı
  composerLabel: "Mesaj",
  composerPlaceholder: "Bir soru yazın…",
  send: "Gönder",
  stop: "Durdur",
  stopping: "Durduruluyor…",
  keysHint: "Enter gönderir · Shift+Enter yeni satır · ↑ son soruyu düzenler · Esc kapatır",
  // Hatalar ve boş durum
  openSettings: "Ayarlar → Yapay zekâ",
  loading: "Yükleniyor…",
  offTitle: "Asistan kapalı",
  offText: "Ayarlar → Yapay zekâ bölümünden açabilirsiniz.",
  unavailableTitle: "Asistan şu an kullanılamıyor",
  unavailableText: "Asistan için seçilen yapay zekâ sağlayıcısı şu an kullanılamıyor.",
  errors: {
    notInstalled: "Asistan için seçilen ajan CLI'ı kurulu değil.",
    notLoggedIn: "Ajan CLI'ında oturum açılmamış. Önce bir terminalde oturum açın.",
    notConfigured: "Sağlayıcı henüz ayarlanmamış (model seçilmemiş olabilir).",
    unreachable: "Yapay zekâ sunucusuna ulaşılamıyor.",
    unauthorized: "Yapay zekâ sunucusu API anahtarını kabul etmedi.",
    timeout: "Yanıt çok uzun sürdü ve durduruldu.",
    failed: "Sağlayıcıdan kullanılabilir bir yanıt gelmedi.",
    cancelled: "Yanıt iptal edildi.",
    busy: "Başka bir yanıt hâlâ sürüyor. Birazdan yeniden deneyin.",
    disabled: "Asistan kapalı.",
    hubUnavailable: `${APP_NAME} arka plan hizmeti çalışmıyor.`,
    invalid: "İstek reddedildi.",
  },
  errorGeneric: (detail: string) => `Bir sorun oluştu: ${detail}`,
  errorGenericNoDetail: "Bir sorun oluştu.",
  // Alt bilgi
  nothingSaved: "Hiçbir şey kaydedilmez",
  toolsOff: "araçlar kapalı",
  sentTo: (provider: string) => `${provider} sağlayıcısına gider`,
  keepsCopy: (provider: string) => `${provider} bu sohbetin bir kopyasını kendi oturum dosyalarında saklar.`,
  mayKeepCopy: (provider: string) => `${provider} bu sohbetin bir kopyasını kendi tarafında saklayabilir.`,
  // Ayarlar → Yapay zekâ (asistan satırı) ve maskot menüsü
  settings: {
    enabled: "Asistanı kullan",
    enabledHint: "Her uygulamadan kısayolla açılır. Hiçbir şey kaydedilmez; her açılış yeni bir sohbettir.",
    hotkey: "Kısayol",
    hotkeyHint: "Asistanı açıp kapatır, ör. Ctrl+Alt+Space.",
    hotkeyTaken: "Bu kısayolu başka bir uygulama kullanıyor. Farklı bir kısayol seçin.",
    hotkeyInvalid: "Geçerli bir kısayol değil. Değiştirici tuşlarla bir tuş kullanın, ör. Ctrl+Alt+Space.",
    open: "Asistanı aç",
  },
  openFromMascot: "Asistanı aç",
};
