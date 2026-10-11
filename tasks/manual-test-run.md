# Manuel test turu (planlandı: 2026-10-12)

Bekleyen bütün manuel testler tek listede. Adımlar ve beklenen sonuçlar `docs/manual-tests.md` içinde, buradaki numaralarla. Her maddeyi `[x]` (geçti) veya `[!]` (sorun; kısa not) ile işaretle; notları bana yapıştırman yeterli.

**Kurulum:** Testler **kurulu 0.3.0** sürümüyle yapılır (dev ortamı gerekmez, hub da güncel gelir). Önce 0.2.1 açıkken uygulama içinden güncellemeyi dene (U-0). Log: `%LOCALAPPDATA%\kotilo\logs\kotilo.log`, hub: `%LOCALAPPDATA%\kotilo\hub\`.

Önerilen sıra: yeni sürümün testleri → ajan/terminal akışları → dikte. Yaklaşık süreler parantez içinde.

## 1. 0.3.0 – bakılmamış işler ve temalar (~45 dk)

- [ ] **U-0** Güncelleme: 0.2.1 açıkken güncelleme bildirimi → güncelle → 0.3.0 açılır; ayarlar (font, bildirimler, maskot) korunur; eski bitmiş oturumlar **mavi görünmez** (veritabanı geçişi 011 eskileri "görüldü" sayar); Hakkında'da 0.3.0
- [ ] **U-1** Kotilo dışında (Windows Terminal) biten Claude Code turu → Mission'da mavi Done + görev çubuğunda mavi 1
- [ ] **U-2** O kartı tıkla → Idle, rozet kaybolur
- [ ] **U-3** İki dış tur → **Mark all as seen** → hepsi Idle; hub yeniden başlayınca da görüldü kalır
- [ ] **U-4** Kotilo bölmesinde başka sekmedeyken biten tur → mavi + rozet; sekmeyi açınca temizlenir
- [ ] **U-5** Rozet renkleri/okunabilirlik: izin bekleyen + bitmiş = turuncu 2 → mavi 1 → yok; açık ve koyu görev çubuğunda rakamlar okunur
- [ ] **U-6** "Döndüğümde özet" (dakika = 1): >1 dk dokunma, sonra fareyi oynat → tek özet bildirimi; bekleyen yoksa yok; Rahatsız etmeyin açıkken yok
- [ ] **U-7** Bakılmamış iş hatırlatması (1 dk): tek hatırlatma, hub yeniden başlayınca tekrar etmez
- [ ] **U-8** Maskot: bakılmamış iş varken sakin mavi durur, tıklayınca o oturumu açar
- [ ] **U-9** Appearance'ta koyu/açık temalar arasında gezin: tüm uygulama + açık terminaller anında değişir, okunabilir
- [ ] **U-10** Sistem modu: Windows açık/koyu değişince seçilen temalar uygulanır
- [ ] **U-11** Terminal şeması: Campbell / başka tema / "Same as app"; terminal alanında şerit kalmaz
- [ ] **U-12** Windows Terminal'den içe aktar: One Half Dark + kendi şeman; renkler WT ile aynı; WT dosyaları değişmez; Remove
- [ ] **U-13** Kotilo Dark/Light 0.2.1 ile birebir aynı görünür

## 2. Ajanlar, mesaj kutusu, bölme, zaman akışı (~60 dk) – M4

- [ ] **M2** İzin kartı tuşları canlı ajanla (kartta izin ver / reddet, doğru seçeneğe gider) – M4-7 ile birlikte yapılabilir
- [ ] **M4-1** Claude Code: tek ve çok satırlı mesaj tek prompt olarak gider
- [ ] **M4-2** Codex ve PowerShell'de aynısı (PowerShell'de çok satır uyarısı)
- [ ] **M4-3** Mesaj kutusu mikrofonu ve `Ctrl+Alt+D` ile durdurma
- [ ] **M4-4** `Win+Shift+S` → `Ctrl+V` görsel eki, `.gitignore` ipucu bir kez
- [ ] **M4-5** `@` dosya önerileri, `Esc` terminale döner
- [ ] **M4-6** Kayıtlı promptlar yeniden başlatmada kalır; tanılama zip'inde metin yok
- [ ] **M4-7** Yan yana bölme: iki ajan, dar pencere, sağdaki izin kartı
- [ ] **M4-8** Bölmeyi kapatma yolları; yeniden başlatınca bölme geri gelir
- [ ] **M4-9** Zaman akışı canlı Claude Code oturumu ile (okuma/düzenleme/komut/plan)
- [ ] **M4-10** Değişen dosyalar + diff; dış düzenleme ve commit
- [ ] **M4-11** Hub'ı öldür → zaman akışı boş başlar, logda içerik yok
- [ ] **M4-12** Mission control önizlemeleri, dış oturum, filtreler, küçültünce CPU yok
- [ ] **M4-13** `Alt+1…9`, `Ctrl+,` her odakta çalışır, ajana gitmez

## 3. Diğer ajanlar ve yapay zekâ sağlayıcıları (kurulu olanlar, ~30–60 dk) – M3

Yalnızca makinede kurulu ajanlar; kurulu olmayanları "atlandı" diye işaretle.

- [ ] **A1–A3** Copilot CLI
- [ ] **A4–A5** OpenCode v2
- [ ] **A6–A7** Gemini CLI
- [ ] **A8** Qwen Code
- [ ] **A9–A10** Factory Droid
- [ ] **A11–A13** Cursor CLI (+ Claude Code entegrasyonu ile birlikte)
- [ ] **A14** Özel ajan sihirbazı + `kotilo-hook` protokol olayı
- [ ] **P1** Settings → AI → her kurulu CLI için Test
- [ ] **P2** Ollama uç noktası + anahtar Credential Manager'da, logda yok
- [ ] **P3** Günlük özet ve dikte temizliği Ollama ile, ağ kapalıyken

## 4. Dikte (~30 dk) – M2b

Mikrofon ve bir konuşma modeli gerekir.

- [ ] **D1** Basılı tut – Notepad'e yazar, overlay odak çalmaz
- [ ] **D2** Bas-bırak modu
- [ ] **D3** `Esc` / ✕ ile iptal
- [ ] **D4** Pano görüntüsü geri gelir, Win+V geçmişinde yok
- [ ] **D5** Windows Terminal ve ajan bölmesine yapıştırma
- [ ] **D6** Yönetici olarak açılmış Notepad
- [ ] **D7** Mikrofon kapalı
- [ ] **D8** Model silinmiş
- [ ] **D9** Kısayol başka uygulamada
- [ ] **D10** Son metni tekrar ekle (`Ctrl+Alt+Shift+D`)
- [ ] **D11** Yapay zekâ temizliği
- [ ] **D12** Dosyaya yazma
- [ ] **D13** Ana pencere kapanınca uygulama çıkar
- [ ] **D14** Farklı ölçekli iki monitör
