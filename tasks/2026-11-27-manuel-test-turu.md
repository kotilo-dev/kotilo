# Bekleyen bütün manuel testlerin ortak turu

**Durum:** TAMAMLANDI
**Tarih:** 2026-11-27 (son güncelleme: 2026-11-27)
**Etkilenen yer:** Test kurulu Kotilo 0.11.0 üzerinde; düzeltmeler en sonda toplu olarak kod tabanında, sonra yeni sürüm. SAP'a yazma yok.

## A. BRIEF (işe başlamadan önce)
### Özet
Açıkta kalan bütün manuel testleri kullanıcıyla madde madde yürütüyoruz. Ben bir maddeyi veriyorum, kullanıcı kurulu
0.11.0'da deniyor ve sonucu söylüyor; sorunlar aşağıdaki "Bulgular" tablosuna yazılıyor. Tur bitince bulgular ve
kullanıcının ek notları toplu düzeltilip derlenen sürüm doğrulanıyor ve yayınlanıyor.

### Arka plan
- Adımlar ve beklenen sonuçlar `docs/manual-tests.md` içinde; numaralar oradaki tablolarla aynı.
- Kurulu sürüm kullanıldığı için `dotnet build` / `tauri dev` hazırlıkları gerekmez (hub da kurulumla gelir).
- Kısaltmalar: WR = izleme kuralları (D-083), PL = Claude plan limitleri (D-078), WG = workspace grupları (D-080),
  UI = arayüz ölçeği/fontu (D-081), CX = ajan bağlamı (0.9), U8 = kullanım ekstraları (0.8), DC = doküman kontrolü
  (0.7), W = worktree'ler (0.6), K = Kotilo Deck (0.5), S = Claude auto mode ve arka plan işi (D-070/D-071),
  R = 0.4.0 maddeleri, G/F = 0.3.x düzeltmeleri, M4 = mesaj kutusu/bölme/zaman akışı, U = bakılmamış iş ve temalar,
  D = dikte, A/P = diğer ajanlar ve yapay zekâ sağlayıcıları.

### Kapsam / Kapsam dışı
Kapsam (sırasıyla):
1. WR-1…WR-8
2. Son UI işleri: genişleyen sol menü, katmanlı görünüm, UX gözden geçirme noktaları, dikte overlay başlığı,
   "Working" takılma düzeltmesi, Artifact/Monitor turunun Done olması, New agent odağı
3. PL-4, PL-6, PL-7, PL-8, PL-9
4. WG-1…WG-8, UI-1…UI-6
5. CX-1…9, U8-1…7, DC-1…10, W-1…12, K-1…8, S-1…5
6. Eski listeler: R-1…14, G-1…11, F-1…15, M4-1…13, U-1…13, D1…D14, A1…A14, P1…P3

Kapsam dışı: MAC-* (Mac gerekiyor), U8-8 ve Linux güncellemesi (VM), performans ölçümü (ikinci makine),
N-* ntfy (özellik yapılmadı), M6/M7/T-* (daha önce onaylandı). Kullanıcı daha önce geçtiğini bildiği maddeyi
"geçti" diye atlayabilir.

### Plan
- [x] 1. Bölüm 1–6 maddelerini sırayla yürüt, sonuçları aşağıya işle
- [x] 2. Kullanıcının ek notlarını al
- [x] 3a. Bulguları düzelt (Sonnet), bağımsız inceleme (Fable: 1 büyük + 5 küçük bulgu, hepsi düzeltildi), kendi kontrolümde 1 ek hata (başka workspace'e geçişte odak) düzeltildi; tam doğrulama yeşil
- [x] 3b. Yerel kurulum paketinde kullanıcı doğrulaması: hepsi ✅ (B5 ikinci düzeltmeyle); kullanıcı B9'u buldu, düzeltildi (e2e ile doğrulandı)
- [x] 4. Sürüm çıkar ve yayınla (kullanıcı 2026-11-27 "direkt sürüm çık" dedi)

### Riskler ve varsayımlar
- Kurulu sürüm 0.11.0 varsayılıyor (Hakkında'dan teyit).
- Bazı maddeler kurulu olmayan ajan, Deck veya ikinci monitör ister; bunlar "atlandı" olarak işaretlenir.

### ⚠ Senden beklenenler (başlamadan önce)
Senden beklenen bir şey yok.

### Kararlar
- 2026-11-27: Kullanıcı testleri kurulu sürümde yapmayı, düzeltmeleri en sonda toplu yapıp derlenen sürümle
  yayınlamayı seçti.

## Sonuçlar
İşaretler: ✅ geçti, ❌ sorun (bulgu no.), ⏭ atlandı (neden).

| Madde | Sonuç | Not |
|---|---|---|
| WR-1 | ✅ | Zaman akışında ⚠ Secret file (cat ve cp). Kart yalnızca `ask` kuralıyla çıktı (auto mode / izinli Bash); kartta "Rule: Secret file" göründü. Adım düzeltmesi B1. |
| WR-2 | ✅ | Kart yok, "Force push" bildirimi geldi, zaman akışında işaret var. |
| WR-3 | ✅ | `rm -rf node_modules` işaretsiz, `rm -rf /c/temp/x` ⚠ Wide delete. |
| WR-4 | ✅ | İki force push, tek bildirim, iki satırda da işaret. |
| WR-5 | ✅ | Kullanıcı kuralı `npm\s+publish`: test listesinde göründü, bildirim geldi, satırda "⚠ npm publish". |
| WR-6 | ✅ | Açmadan önce işaretsiz, "Bu projenin kurallarını kullan" açılınca ⚠ Hello test. Ayarı kullanıcı bulamadı (B3). |
| WR-7 | ✅ | Bozuk dosya: "Line 3: The file is not valid JSON." Geçersiz desen kaydederken uyarı verdi; diğer kurallar çalıştı. Gözlem B4. |
| WR-8 | ✅ | Ben doğruladım: `%LOCALAPPDATA%\kotilo` (loglar, hub.db, WAL) içinde test komutlarının metni yok. "npm publish" yalnızca kullanıcı kuralının adı olarak `hub/settings.json`'da; "dry-run" yalnızca Görevler'in indekslediği başka projelerin Markdown görev satırlarında. |
| Sol menü genişletme | ✅ | Genişliyor, yeniden açılışta korunuyor. |
| Katmanlı görünüm / sayfa düzeni | ✅ | Koyu ve açık temada sorun yok. |
| UX gözden geçirme 11a–11f | ✅ | Ayar filtresi, CLI/hook ayrımı, kaydedilmemiş nokta, ataç düğmesi, Yeni grup / Gruptan çıkar, sekme adları. |
| Dikte overlay başlık çubuğu | ✅ | Başlık çubuğu çıkmadı, metin yazıldı. |
| Artifact / Monitor turu → Done | ✅ | İkisi de Done oldu, Working'de takılmadı. |
| Odak 14a–14d | ❌ kısmen | Yeni ajan/terminal, gönderim sonrası ve workspace seçimi tamam. Sorunlar B5, B6. |
| PL-4 | ⏭ | Kullanıcının kendi status line'ı var; "anahtar silinir" durumu bu makinede oluşmuyor. |
| PL-6 | ✅ | Kapatınca `statusLine` kullanıcının `statusline_combined.py` komutuna döndü; yedekle karşılaştırma: başka anahtar değişmedi. Claude'da kendi satırı ("Opus 5.5 · ctx 17%") görünüyor. |
| PL-5 | ✅ | Açınca zincir: `Opus 5.5 · ctx 6% · 5h 0% (4h58m) · wk 74% · cache 65% (1h00m)`; `statusLine` yeniden Kotilo'yu gösteriyor. |
| PL-9 | ✅ | `cache 65% (1h00m)`, bir saat sonra yeni prompt olmadan `cold`. |
| PL-8 | ✅ | Başına `x` eklenmiş dosyada anahtar ve "Install hooks" gri, iki uyarı; dosya dokunulmadı (yedek sayısı 14 kaldı), düzeltilince hash baştakiyle aynı (`e83ff79…`). Anahtar bu sırada "kapalı" görünüyor (gerçekte açık); not açıkladığı için bulgu yazılmadı. |
| WG/UI | ⏭ / ✅ | WG-1…8 ve UI-1…5 2026-11-25'te dev sürümde denenmişti. O turun düzeltmeleri: Türkçe "İş"/"iş" aynı ad sayılıyor ve başlık "İş" kalıyor ✅; "Yüklü fontlar…" listesi (UI-6) üç alanda çalışıyor ✅. |
| CX-1…CX-9 | ✅ | Ajan bağlamı: içe aktarma, on demand, MCP gizli değer gizli, önizleme, Codex, yenileme, palet/pane düğmesi, Türkçe. |
| U8-1…U8-7 | ✅ | Tepsi ipucu, menü, bekleyen ajan, haftalık grafik, Türkçe. U8-1'in "✕ ile kapanır" kısmı PL-7 ile sona. |
| DC-1…DC-7, DC-9, DC-10 | ✅ | Doküman kontrolü, eksik yol, bayatlık, Mark reviewed, bozuk toml, ajanla güncelle, rozet kapatma, CLI çıkış kodu, Türkçe. |
| DC-8 | ⏭ | 0.7 öncesi worktree'li depo gerekiyor, yeniden üretilemiyor. |
| W-1…W-6 | ✅ | Worktree oluşturma, iki ajan ayrı klasörde, proje/dal eşlemesi, Compare, commit'siz Merge reddi, normal Merge. |
| W-7…W-12 | ✅ | Çakışma, squash, çalışan ajanla silme, ikinci onay, oturum devamı, alt klasör / repo olmayan klasör. |
| K-1…K-8 | ✅ | Kullanıcı daha önce denemiş; bugünkü `kotilo.log`'da uyarı/hata seviyesinde `deck:` satırı yok (ben baktım). |
| S-1…S-5 | ✅ | Ön plan uzun komut Working, 12 dk arka plan shell'i, ask kuralıyla kart, OSC 8 tek açılış, tam ekranda bağlantılar. |
| R, G, F, M4, U, D grupları | ✅ | Kullanıcı günlük kullanımda sorunsuz gördüğünü bildirdi (tek tek yürütülmedi). |
| A1…A14, P1…P3 | ⏭ | Kullanıcı atladı (diğer ajanlar / sağlayıcılar). |
| PL-7 | ✅ | Kotilo kapalıyken dış terminaldeki Claude'un status line'ı gecikmesiz çalıştı. |
| U8-1 (kapanış) | ✅ | Tepsi ayarı kapalıyken ✕ uygulamayı kapattı, simge kayboldu. |

## Bulgular (düzeltilecekler)
| # | Madde | Sorun | Önem | Durum |
|---|---|---|---|---|
| B1 | WR-1 | Test adımı hatalı: Claude Code `cat .env` gibi salt okunur komutları izin sormadan çalıştırıyor (ekranda "Read 1 file" diye özetliyor), bu yüzden kart çıkmıyor. `docs/manual-tests.md` WR-1 izin gerektiren bir komutla yazılmalı (ör. `cp .env .env.bak`). Ürün hatası değil. | Düşük (doküman) | Açık |
| B2 | (gözlem) | Kabuk sekmesinin adı `C:\Program Files\Wind…` (pwsh'ın exe yolu) görünüyor; "PowerShell" ya da klasör adı daha okunur. | Düşük (UX) | Kullanıcı kararı bekliyor |
| B3 | WR-6 | "Bu projenin kurallarını kullan" seçeneği bulunamadı: onay kutusunun etiketi klasör yolu, asıl anlam küçük açıklama satırında (`WatchRulesSettings.tsx:287`). Açık bir "Kullan" anahtarı/etiketi önerisi. | Düşük (UX) | Kullanıcı kararı bekliyor |
| B4 | WR-7 | Geçersiz desenli kural (`npm(`) kaydedildikten sonra listede işaretli ve sorunsuz görünüyor; satırda bir sorun işareti yok (uyarı yalnızca kaydederken çıktı). Düzeltmeden önce kodda doğrulanacak. | Düşük (UX) | Kullanıcı kararı bekliyor |
| B5 | Odak | Alttaki Agents listesinde bir ajana tıklayınca o ajanın terminali klavye odağı almıyor; kullanıcı ayrıca terminale tıklamak zorunda. | Orta | Düzeltildi, yerel pakette doğrulandı |
| B5b | Odak (yerel paket) | İlk düzeltmeden sonra odak yalnızca ilk ajanda kalıyordu. Neden: odak yardımcısı, odak bir metin alanındaysa "kullanıcı başka yere yazıyor" diye vazgeçiyordu; xterm'in giriş alanı da `textarea` olduğundan başka bir terminalin odağı da bu sayılıyordu. Başka terminallerin giriş alanı istisna yapıldı (`terminalRegistry.ts` `focusIsElsewhere`), birim testi eklendi. | Orta | Düzeltildi, yerel kontrol bekliyor |
| B6 | Odak | Üstteki sekmelerden başka bir açık kabuk sekmesine geçince terminal odak almıyor. | Orta | Düzeltildi |
| B9 | Odak | Önceki Kotilo oturumundan geri yüklenen ajan sekmesinde "Start claude" düğmesine basınca terminal odak almıyor. Neden: düğme tıklanınca kaplama kalkıyor ve odak `<body>`'ye düşüyordu; artık başlatmadan sonra terminale veriliyor (`TerminalView.tsx` `startFromOverlay`, "Start shell only" için de). e2e `restore.spec.ts` odağı kontrol ediyor. | Orta | Düzeltildi (2026-11-27) |

## Kullanıcı notları (tur sonu)
- B7: Workspaces sekmesinde grup başlıkları ile workspace satırları birbirine karışıyor; ağaç gibi girintili olsun, ayrım belirgin olsun.
- B8: Workspace satırının altındaki yol ev klasörünü açık yazıyor (`C:\Users\tr11677\dev\…`); `~\dev\…` biçiminde kısaltılsın.
- 2026-11-27: Kullanıcı B2, B3, B4'ün de düzeltilmesini istedi.

## Doğrulama (2026-11-27)
- vitest 126 dosya / 1181 test geçti; UI build tamam; clippy temiz; `cargo test --workspace` hepsi ok; tam e2e 172/172 (`--workers=2`).
- Gerçek pencerede doğrulanmadı: B5/B6 odak, B8 `~` (e2e yolları ev klasörü altında değil), B4 işareti (yalnızca birim testi).

## Yerel paket kontrol listesi (kullanıcı yeni sürümü kurunca bunu isteyecek)
Paket: `target\release-artifacts\x64\Kotilo_0.11.0_x64-setup.exe` (sürüm numarası bilerek 0.11.0; yayında 0.11.1).
Kurulum: Kotilo'yu tamamen kapat (tepside de), kurulum dosyasını çalıştır, Kotilo'yu aç.

| # | Adım | Beklenen | Sonuç |
|---|---|---|---|
| B2 | Bir PowerShell sekmesi aç | Sekme adı `C:\Program Files\Wind…` değil, "PowerShell" (veya profil adı) | ✅ |
| B3 | Ayarlar → Bildirimler → İzleme kuralları → Proje kuralları | Onay kutusu yazısı "Bu projenin kurallarını kullan", klasör yolu altında küçük mono yazıyla | ✅ |
| B4 | `npm(` desenli kural ekle, kaydet; sonra deseni düzeltip kaydet | Kuralın kendi satırında ⚠ ve "Uygulanmıyor: …"; düzeltince kaybolur | ✅ |
| B5 | Alttaki Agents listesinde bir ajana tıkla ve hemen yaz; başka workspace'teki ajanla da dene | Yazılanlar doğrudan o ajanın terminaline gider | ✅ (ikinci paket, B5b sonrası) |
| B6 | Üstte başka bir kabuk sekmesine tıkla ve hemen yaz | Yazılanlar o terminale gider | ✅ |
| B6 ek | Sekme adına çift tıkla, yeni ad yaz, Enter; ad kutusunun içine tıklayıp imleci taşı | Ad kutusu açık kalır, yeniden adlandırma çalışır (inceleme bulgusu gerileme kontrolü) | ✅ |
| B7 | Workspaces sekmesinde gruplara bak | Gruptaki workspace'ler girintili, solda ince çizgi; başlıklar belirgin | ✅ |
| B8 | Workspace satırındaki yola bak, üzerine gel | Yol `~\dev\…`; ipucunda tam yol | ✅ |

Hepsi geçerse: sürüm 0.11.1, commit (kullanıcı isteyince), etiket, yayın.

## Bekleyen kararlar (2026-11-27)
1. Sigstore/GitHub attestation (`actions/attest-build-provenance`) 0.11.1'e eklensin mi? (önerim: evet)
2. İmza: Certum Open Source Code Signing (bulut, ~49 €/yıl, https://shop.certum.eu/open-source-code-signing-on-simplysign.html) şimdi mi, SignPath beklensin mi? Not: repo 0 yıldız, gerçek indirme ~yok (her varlık 4 = bot), SignPath itibar şartı nedeniyle bekliyor olabilir. Kullanıcı Certum sayfasına bakıyordu (SSL ürünleri değil, Open Source Code Signing).
3. Wiki sayfası: kapsam (yalnız Desktop / tüm aile), dil (EN / EN+TR), kaynak (user-guide.md'den üretme önerildi).
4. MSIX/Store denemesi sonraki işlere eklensin mi? (önerim: önce Certum; Store sonra, keşfedilme için)

## Sonraki iş (kullanıcı isteği, 2026-11-27)
Bu tur ve 0.11.1 yayını bitince: kotilo.dev'e wiki tarzı bir sayfa — ürünün bütün özellikleri adım adım, nasıl
çalıştıklarıyla. Ayrı görev dosyasıyla planlanacak. Not: kotilo-site'ta stüdyo ana sayfası hâlâ commit bekliyor.

## Düzeltme planı
| # | Değişiklik | Nerede (başlangıç noktası) |
|---|---|---|
| B1 | WR-1 adımı izin isteyen komutla (`cp .env .env.bak`) ve auto mode için `ask` kuralı notuyla yazılır | `docs/manual-tests.md` |
| B2 | Kabuk sekmesinin başlığı bir exe yolu ise (pwsh'ın pencere başlığı) yol yerine kabuğun adı gösterilir | terminal sekme başlığı mantığı (`features/terminal/`) |
| B3 | Proje kuralı onay kutusunun etiketi "Bu projenin kurallarını kullan" olur, klasör yolu ikinci satıra iner | `features/settings/WatchRulesSettings.tsx:287` |
| B4 | Hub'ın geçersiz bulduğu kural, kural listesindeki kendi satırında uyarı işareti ve nedeniyle gösterilir | `WatchRulesSettings.tsx` (hubProblems → satır) |
| B5 | Agents listesinde ajana tıklayınca terminal klavye odağı alır | Agents paneli tıklama yolu, `features/agents/navigate.ts` |
| B6 | Üstteki sekmeye tıklayıp geçince terminal odak alır | `features/terminal/TerminalPanel.tsx:402` |
| B7 | Grup altındaki workspace satırları girintili ve sol kılavuz çizgili; grup başlığı belirgin | `features/workspaces/WorkspaceList.tsx` |
| B8 | Yol ev klasörü `~` ile kısaltılarak gösterilir (ipucunda tam yol kalır); ev klasörü `app_info`'ya eklenir | `WorkspaceList.tsx:149`, `src-tauri/src/commands/app.rs` |

Doğrulama: vitest, ilgili e2e (+ ekran görüntüleri), cargo test + clippy, UI build. Sonra yerel kurulum paketi
(`scripts/release.ps1 -Arch x64`) kullanıcıya doğrulatılır, ardından 0.11.1 sürümü.

## B. RAPOR (iş bittikten sonra)
### Sonuç
Manuel test turu bitti; bulunan dokuz sorun (B1–B9) düzeltildi ve 0.11.1 olarak yayınlandı.

### Yapılanlar
- Açık manuel testler kurulu 0.11.0'da kullanıcıyla yürütüldü (sonuçlar yukarıdaki tabloda); geçen gruplar `todo.md`'de işaretlendi.
- B1–B9 düzeltildi: test adımı (B1), kabuk sekmesi adı (B2), proje kuralı etiketi (B3), geçersiz kural işareti (B4), üç odak sorunu (B5, B6, B9), gruplu workspace listesi (B7), `~` kısaltması (B8).
- Commit'ler: `948621a` (düzeltmeler), `7665c73` (Release 0.11.1), etiket `v0.11.1`.

### Nasıl doğrulandı
- vitest 126 dosya / 1182 test, UI build, tam e2e 172/172 (yerelde, B9 sonrası). Rust tarafı (`app.rs`) B8 sırasında `cargo test` + clippy ile doğrulanmıştı; sonra Rust değişmedi.
- B9 için e2e `restore.spec.ts`: düzeltme olmadan kırıldı, düzeltmeyle geçti.
- B2–B8 ve B5b kullanıcı tarafından yerel kurulum paketinde doğrulandı. B9 gerçek pencerede doğrulanmadı (yalnızca e2e).

### Değişen nesneler / dosyalar
`TerminalView.tsx`, `TerminalPanel.tsx`, `focusTab.ts` (yeni), `terminalRegistry.ts`, `navigate.ts`, `AgentsPanel.tsx`, `terminalExtras.ts`, `terminalStore.ts`, `WatchRulesSettings.tsx`, `WorkspaceList.tsx`, `paths.ts`, `ipc.ts`, `platform.ts`, `commands/app.rs`, i18n dosyaları, testler, `docs/manual-tests.md`, sürüm dosyaları.

### Yapılmayanlar ve açık kalanlar
- A1…A14, P1…P3 (diğer ajanlar/sağlayıcılar) kullanıcı tarafından atlandı.
- DC-8 yeniden üretilemiyor (0.7 öncesi worktree gerekiyor).
- Mac, Linux VM, ikinci makine ve ntfy maddeleri kapsam dışıydı; `todo.md`'de açık.

### ⚠ Senden beklenenler (şimdi)
| # | Eylem | Neden | Aciliyet | İşi durduruyor mu? (Evet/Hayır) |
|---|---|---|---|---|
| 1 | 0.11.1'e güncelleyince eski oturumdan kalan bir ajan sekmesinde "Start claude"a basıp hemen yaz | B9 yalnızca e2e ile doğrulandı | Düşük | Hayır |
| 2 | Yukarıdaki "Bekleyen kararlar" (attestation, Certum, wiki, MSIX) | Sonraki işlerin sırası bunlara bağlı | Düşük | Hayır |

### Sonraki oturum için not
0.11.1 yayında. Sıradaki iş: kotilo.dev wiki sayfası (ayrı görev dosyası) ve kotilo-site stüdyo ana sayfasının commit'i.
