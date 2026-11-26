# Tüm ekranların UX/UI gözden geçirmesi

**Durum:** TAMAMLANDI
**Tarih:** 2026-11-26 (son güncelleme: 2026-11-26)
**Etkilenen yer:** `apps/desktop/src`, `apps/desktop/e2e`, `apps/desktop/playwright.config.ts` (React arayüzü; Rust ve hub değişmedi). SAP'a yazma yok.

## A. BRIEF (işe başlamadan önce)

### Özet
Uygulamanın bütün ekranlarını kullanıcı deneyimi (UX: anlaşılırlık, bulunabilirlik, akış) ve görsel düzen
(UI: hiyerarşi, boşluk, hizalama, kontrast) açısından gözden geçirip sorunları önceliklendirilmiş bir
listeye dökeceğiz. Ardından kullanıcının seçtiği maddeleri uygulayacağız. Çıkış noktası, kullanıcının bir
önceki işte fark ettiği "Gruptan çıkar bulunamıyor" türünden, ilk bakışta anlaşılmayan yerler.

### Arka plan
- **Ekran görüntüleri:** Playwright e2e testleri (`apps/desktop/e2e/*.spec.ts`) sahte IPC ve sahte hub ile
  uygulamayı tarayıcıda açıp `apps/desktop/test-results/screens/` altına koyu/açık tema ve EN/TR ekran
  görüntüsü kaydediyor. Gözden geçirme bu görüntülerin üzerinden ve ilgili bileşen kodu okunarak yapılır.
- **Tasarım kuralları:** `DESIGN_SYSTEM.md` (token'lar, bileşenler, erişilebilirlik §9, metin tonu §10).
  Öneriler bu kurallara uymalı ya da kuralın değişmesini açıkça önermeli.
- **Fable:** Ucuz/hızlı model; burada eleştirmen ve fikir üretici olarak kullanılır. Bulgular "öneri"dir,
  son karar ana oturumda ve kullanıcıdadır.
- **Önem dereceleri:** Y (yüksek) = kullanıcı bir işi yapamıyor ya da yanlış anlıyor; O (orta) = iş
  yapılıyor ama zorlanarak; D (düşük) = görsel cila.

### Kapsam / Kapsam dışı
- Kapsam: ana pencere (workspace paneli, terminal/ajan paneli, composer, viewer, zaman akışı), Mission
  Control, Görevler, Raporlar/Kullanım, Oturumlar, Ayarlar, Yardım, komut paleti, modal ve diyaloglar,
  boş durumlar, açık tema ve Türkçe metinler.
- Kapsam dışı: yeni özellik eklemek, marka/logo değişikliği, hub (.NET) ve Rust tarafı (UI gerektirmedikçe),
  web sitesi.

### Plan
- [x] 1. Bütün e2e testlerini çalıştırıp güncel ekran görüntülerini üret.
- [x] 2. Ekranları gruplara ayırıp Fable eleştirmenlerine ver (her grup: görüntüler + bileşen kodu + DESIGN_SYSTEM).
- [x] 3. Bulguları kendim doğrula (görüntüye ve koda bakarak), tekrarları birleştir, önceliklendir.
- [x] 4. Bulgu listesini bu dosyada "Bulgular" tablosu olarak yaz; kullanıcıdan uygulanacak maddeleri seçmesini iste.
- [x] 5. Seçilen maddeleri uygula; testleri ve ekran görüntülerini güncelle.
- [x] 6. Değişen ekranlara tekrar bak, raporu yaz.

### Riskler ve varsayımlar
- Ekran görüntüleri sahte veriyle üretiliyor; gerçek uygulamadaki bazı durumlar (gerçek terminal çıktısı,
  yerel pencere diyalogları) görünmeyebilir. Bunlar "doğrulanamadı" olarak işaretlenecek.
- Görsel zevk öznel; "UI güzelleştirme" önerileri ayrı bir sınıf olarak (D) sunulacak, UX sorunlarının önüne geçmeyecek.
- Varsayım: tasarım dili (koyu, sessiz yüzey, durum renkleri) korunur; köklü bir yeniden tasarım istenmiyor.

### ⚠ Senden beklenenler (başlamadan önce)
| # | Karar / eylem | Neden gerekli | İşi durduruyor mu? (Evet/Hayır) | Cevap |
|---|---|---|---|---|
| 1 | Bulgu listesinden hangi maddelerin uygulanacağını seçmek | Değişiklikler birçok ekranı etkiler; öncelik senin | Evet (yalnızca 5. adımı) | |

### Kararlar
- 2026-11-26: İnceleme (1–4. adımlar) onay beklemeden yapılıyor, çünkü kod değiştirmiyor. Uygulama (5. adım) bulgu listesi onaylanınca başlar.
- 2026-11-26: İnceleme bitti, 7 paket halinde bulgu listesi çıkarıldı. Hangi paketlerin uygulanacağı kullanıcıya soruldu.
- 2026-11-26: Kullanıcı 7 paketin hepsini seçti. Uygulama 5 paralel Sonnet uygulayıcıyla, her biri ayrı git worktree'de (`.worktrees/ux-a…e`, mevcut commit edilmemiş değişikliklerin anlık görüntüsünden) yapılıyor: A = P1 + P2 onay pencereleri + diyaloglar, B = P3 ana pencere, C = P4 + P7, D = P5 ayarlar, E = P6 sayfalar. Paralel e2e için `playwright.config.ts` portu `E2E_PORT` ortam değişkeninden okuyacak şekilde değiştirildi. Sonuçlar ana çalışma ağacında birleştirilecek, ardından Fable fark incelemesi yapılacak.
- 2026-11-26: İki bağımsız Fable kod incelemesi iki klavye gerilemesi buldu: bağlam menüsünde odak her saniye ilk öğeye atlıyordu ve onay pencereleri "İptal" odaklı açılıyordu. İkisi de düzeltildi; onay penceresi yine onay butonu odaklı açılıyor (dosya ağacında Delete + Enter yine siliyor).
- 2026-11-26: İzin kartını terminalin altına yerleştirme (P3-2) geri alındı. Neden: kart her açılıp kapandığında terminal (PTY) 2–3 kez yeniden boyutlanıyor; ajanın arayüzü yeniden çiziliyor ve ekrandan izin algılayan ajanlarda (Cursor) algılama bozulabilir. Kart eskisi gibi üst katmanda; buton yazısı ve komut kaydırma düzeltmeleri korundu.
- 2026-11-26: "Worktree'ler" Türkçe terimi uygulamanın her yerinde kullanıldığı için değiştirilmedi (eleştirmen "Çalışma ağaçları" önermişti).
- 2026-11-26: Plan limitleri yalnızca Genel bakış'ta gösteriliyor; Görev kontrolden kaldırıldı (P6-4 "limitler tek yerde").

### Bulgular

Beş Fable eleştirmeni 5 ekran grubunu inceledi (ana pencere, sayfalar, ayarlar, diyaloglar, asistan/maskot)
ve toplam 70 bulgu getirdi. Tekrarları birleştirip 7 iş paketine ayırdım. "Doğrulama" sütunu: **G** = ekran
görüntüsünde kendim gördüm, **K** = kodda kendim gördüm, **E** = yalnızca eleştirmenin tespiti, henüz
kontrol etmedim. Kimlik biçimi: `P<paket>-<sıra>`. Önem dereceleri: Y = yüksek, O = orta, D = düşük.

**P1 — Hızlı ve kesin düzeltmeler** (küçük, düşük riskli; her biri birkaç satır)
| Kimlik | Önem | Sorun | Önerilen çözüm | Doğrulama |
|---|---|---|---|---|
| P1-1 | Y | Komut paleti pencereden taşıyor; son satırlar ekranın altında kalıyor (liste en fazla 1200px). | Liste yüksekliğini pencereye göre sınırla. `QuickPick.tsx` | G, K |
| P1-2 | Y | Kalıcı izin butonunun yazısı kesiliyor ("Don't ask again for npm test commands in C:…"); kapsamı anlatan kısım tam da kaybolan kısım. | Buton yazısı alt satıra geçebilsin, kendi satırında tam genişlik olsun. `PermissionCard.tsx` | G, K |
| P1-3 | O | İzin kartındaki komut kelime ortasından bölünüyor ("datab/ase"). | `break-all` yerine `overflow-wrap:anywhere`. `PermissionCard.tsx` | G, K |
| P1-4 | O | Ayarlarda açıklamalı onay kutuları açıklamasızlardan küçük görünüyor. | Onay kutusu sıkışmasın (`shrink-0`). `controls.tsx` | K |
| P1-5 | O | Türkçede tema aile adları Türkçe kurala göre büyütülüyor: "KOTİLO", "TOKYO NİGHT". | Bu başlıklarda dili İngilizce işaretle. `ThemeSettings.tsx` | K |
| P1-6 | D | Composer'a odaklanınca çift odak çerçevesi çıkıyor (dış kutu + kare iç çerçeve). | İç çerçeveyi kaldır. `Composer.tsx` | G |
| P1-7 | O | Durum çubuğundaki ajan sayaçları (⛨1 ◔1 ✓1) açıklamasız, tıklanamıyor. | Her sayaca açıklama ("1 ajan izin bekliyor") ve tıklayınca o ajana gitme. `StatusBar.tsx` | K |
| P1-8 | O | Türkçede yarım çeviriler: Görev kontrolde "context 41%", "WORKTREE'LER". | Eksik metinleri çevir. `tr.ts` | E |
| P1-9 | O | Hızlı açma boş sorguda altı boş bir "Open tabs" başlığı gösteriyor; paletlerde tuş ipucu yok. | Boşken başlığı gizle, açıklama ve tuş ipucu satırı ekle. `QuickPick.tsx` | E |
| P1-10 | Y (test) | Ekran görüntüsü testinde Oturumlar sayfası eksik; görüntüler bir sonraki sayfanın adıyla kaydediliyor, Ayarlar ana sayfası hiç yakalanmıyor. | Listeyi düzelt, Ayarlar'ı Ctrl+, ile aç. `e2e/screens.spec.ts` | K |

**P2 — Onay pencereleri ve renk disiplini** (kırmızı yalnızca tehlikeli işlemde)
| Kimlik | Önem | Sorun | Önerilen çözüm | Doğrulama |
|---|---|---|---|---|
| P2-1 | Y | `ConfirmModal` (9 yerde kullanılıyor) onay butonunu her zaman kırmızı çiziyor; zararsız "Mark reviewed" tehlikeli görünüyor. Ayrıca diğer diyaloglardan farklı, küçük ve eski bir görünümü var. | `ConfirmModal`'ı ortak `Dialog` + `Button` üzerine taşı; `tone` seçeneği ekle, kırmızıyı yalnızca silme/kaldırma çağrılarında ver. | G, K |
| P2-2 | O | Ajanlar ayarında ~10 kırmızı çerçeveli buton (Uninstall, Remove, Delete); worktree listesinde her satırda kırmızı "Remove". Göz, ilgilenilmesi gereken kartlara değil yıkıcı butonlara gidiyor. | Bu butonları sakin (ghost/ikincil) yap; kırmızıyı onay adımına bırak. `AgentsSection.tsx`, `WorktreesPanel.tsx` | E |
| P2-3 | O | Satır eylemleri her ekranda farklı: "Delete" bir yerde kırmızı çerçeveli, bir yerde düz yazı. | Tek kural: nötr eylem = küçük ikincil buton, yıkıcı = küçük tehlike butonu. `controls.tsx` + `AiSection`, `QuickCommandsSection`, dikte geçmişi | E |
| P2-4 | O | Bağlam menülerinde "Remove" (çalışma alanını kaldır) "Rename"in hemen altında ve sıradan görünüyor; "Remove from group" ile karışabilir. | "Remove workspace" adıyla menünün sonuna, kırmızı yazıyla taşı; menüye `danger` seçeneği ekle. `ContextMenu.tsx`, `WorkspaceList.tsx` | G |
| P2-5 | D | Asistanda "Stop" kırmızı; Pomodoro çipindeki kırmızı nokta "bekleyen ajan" sayacının yanında. | Stop'u ikincil, odak noktasını vurgu rengi yap. | E |

**P3 — Ajan kimliği ve ana pencere düzeni**
| Kimlik | Önem | Sorun | Önerilen çözüm | Doğrulama |
|---|---|---|---|---|
| P3-1 | Y | Ajan sekmelerinin hepsi "PowerShell" adını taşıyor; Claude ile Codex'i yalnızca 5px'lik bir nokta ayırıyor. Ajan listesi ve bölünmüş panel başlıkları da "PowerShell" tekrarlıyor. | Ajan sekmesinin varsayılan adı ajan harfi + proje adı olsun ("C orders-service"); kabuk adı yalnızca düz terminallerde. `TerminalPanel.tsx`, `AgentsPanel.tsx` | G |
| P3-2 | Y | İzin kartı terminalin üstüne biniyor; "terminaldeki istemi oku" derken o istemi kapatabiliyor. | Kartı terminalin altına yerleştir, terminal küçülsün. `AgentPane.tsx`, `PermissionCard.tsx` | G, K |
| P3-3 | O | Ajan başlık şeridi durum değişince yeniden diziliyor; ajan "izin bekliyor"a geçtiği anda terminal ~30px zıplıyor; bölünmüş görünümde 4 satıra çıkıyor. | Sabit iki satırlı ızgara; dar alanda tek satırlık özet. `AgentHeaderStrip.tsx` | G |
| P3-4 | O | Ajan listesinde hiyerarşi ters: ajan adı soluk, her satırda aynı olan proje adı parlak. | Harf avatarı ekle, ajan adını öne çıkar, tekrarlayan sütunları gizle. `AgentsPanel.tsx` | G |
| P3-5 | O | Zaman akışında Etkinlik listesi satır ortasında kesiliyor, altında ~100px boşluk var. | Etkinlik kalan alanı doldursun, Değişen dosyalar içeriği kadar yer alsın, kesilen yerde solma efekti. `TimelineRail.tsx` | G |
| P3-6 | O | Değişen dosyadan diff açılınca görüntüleyici ~345px kalıyor; kod satırları okunamıyor. | Diff açılınca görüntüleyiciyi en az ~480px'e genişlet. | E |
| P3-7 | O | Panel başlık butonları 20px (tasarım kuralı en az 32px tıklama alanı); "New agent ▶" menü açtığı halde "çalıştır" simgesi kullanıyor. | Butonları 24–26px'e büyüt, ▶ yerine ▾. `index.css`, `TerminalPanel.tsx` | G |
| P3-8 | D | Dar panelde composer butonları ikinci satıra düşüyor. | Dar genişlikte ekle/kayıtlı istemleri tek "+" menüsünde topla. `Composer.tsx` | G |

**P4 — Bulunabilirlik** (işlevi olan ama görünmeyen şeyler)
| Kimlik | Önem | Sorun | Önerilen çözüm | Doğrulama |
|---|---|---|---|---|
| P4-1 | O | Sol menü (nav rail) yalnızca simgelerden oluşuyor; Oturumlar/Raporlar/Görevler simgeleri kendini anlatmıyor. İki eleştirmen ayrı ayrı buldu. | Simgelerin altına 10–11px etiket (menü ~64px) ya da etiketli genişletilebilir menü. `NavRail.tsx` | G |
| P4-2 | O | Çalışma alanı eylemlerinin hepsi yalnızca sağ tıkta; klavyeyle menü açılamıyor (Shift+F10 yok). | Satır üzerine gelince "⋯" butonu ve Shift+F10 / Menü tuşu. `WorkspaceList.tsx` | G, E |
| P4-3 | Y | Görev kontrolde izin bekleyen ajan kartında hiçbir eylem yok; uygulama dışında çalışan oturumda kart tıklanamıyor bile. | Bekleyen kartlara eylem satırı: "Ajana git", dışarıdaysa "Kendi terminalinde yanıtla". `MissionControlPage.tsx` | G |
| P4-4 | O | Docs kontrolü yalnızca çalışma alanı sağ tık menüsünde ve palette; görünür bir girişi yok. | Dosyalar veya görüntüleyici başlığına "Docs" girişi. | E |
| P4-5 | D | Menülerde pasif öğeler ("Split right", "Review changes") neden pasif olduğunu söylemiyor. | Pasif öğeye kısa açıklama. `ContextMenu.tsx` | E |
| P4-6 | O | Komut adları tutarsız ("Agent:" / "Agents:", "Docs: Check" ↔ "Check docs"); yıkıcı "Uninstall" komutu en sık kullanılanların hemen altında; "Go:" komutları kısayol sırasında değil. | Tek önek düzeni, menü ve palette aynı adlar, yıkıcıları sona al. `commands.ts` ve ilgili dosyalar | G |

**P5 — Ayarlar düzeni**
| Kimlik | Önem | Sorun | Önerilen çözüm | Doğrulama |
|---|---|---|---|---|
| P5-1 | Y | Ajan kartında "Installed" iki ayrı şey için kullanılıyor: CLI'ın kurulu olması ve Kotilo hook'larının kurulu olması. "Not found on PATH" + "Installed, needs an update" yan yana. | "CLI bulundu / bulunamadı" ve "Hook'lar kurulu / güncelleme gerekiyor"; butonlar "Install hooks / Remove hooks". `AgentsSection.tsx`, `en.ts`, `tr.ts` | E |
| P5-2 | Y | Üç farklı kaydetme davranışı: bazı bölümler anında kaydediyor, hub bölümleri yalnızca alttaki yapışkan çubukla, AI bölümünde ikisi karışık. Kullanıcı kaydetmeden çıkabiliyor. | Hub bölümlerinde "Kaydet gerekir" notu ve menüde kaydedilmemiş değişiklik noktası; ileride otomatik kaydetme. `SettingsPage.tsx` | E |
| P5-3 | Y | Ana bildirim anahtarı Ajanlar bölümünde; ayrıca bir "Notifications" bölümü var. | Bildirim ayarlarını Notifications bölümünde topla. | E |
| P5-4 | O | 14 bölüm, arama yok; bazı ayarlar beklenmedik yerde (worktree dal öneki Terminal altında). | Ayarlarda filtre kutusu; bölümleri 3 başlık altında grupla. | E |
| P5-5 | O | Görünüm'de "Theme" seçimi (koyu/açık) ile palet ızgarası ayrı; palet ekranın altında kalıyor. | Seçimi "Mode" adıyla segmentli kontrol yap, paleti hemen altına al. `AppSections.tsx` | E |
| P5-6 | O | Ana anahtar kapalıyken bağlı ayarlar (maskot boyutu, dikte temizleme sağlayıcısı) etkin görünüyor. | Bağlı kontrolleri soluklaştır veya gizle. | E |
| P5-7 | O | Özel ajan sihirbazında kazara dış tıklama 5 adımlık girişi siliyor; düzenli ifade jargonu ("lookaround"). | Sihirbazda dış tıklamayla kapanmayı kapat, ipucunu örnekle yeniden yaz. `CustomAgentWizard.tsx`, `controls.tsx` | E |

**P6 — Sayfa iskeleti ve görsel cila**
| Kimlik | Önem | Sorun | Önerilen çözüm | Doğrulama |
|---|---|---|---|---|
| P6-1 | O | Sayfa başlıkları tutarsız: sağdaki eylemler farklı yüksekliklerde, filtreler kimi sayfada başlıkta kimisinde ayrı satırda. | Ortak iskelet: başlık + sayfa eylemleri, altında tek filtre satırı. | E |
| P6-2 | O | Açık temada ikincil butonlar gri dolgulu; pasif gibi görünüyor. | Açık temada ikincil buton beyaz zemin + çerçeve. `index.css` | E |
| P6-3 | O | Yerel (işletim sistemi görünümlü) açılır listeler özel kontrollerin yanında göze batıyor. | Ortak, stilli `Select` bileşeni. `SessionsPage`, `ProjectsPage` | E |
| P6-4 | O | Genel bakış'ta "Needs you · 1" bandı hangi ajanın beklediğini söylemiyor; plan limitleri hem burada hem Görev kontrolde aynen tekrar ediyor. | Bandın yerine bekleyen ajanların kısa listesi; limitler tek yerde. `OverviewPage.tsx` | G |
| P6-5 | O | Genel bakış'ta yerel 5 saatlik tahmin ile plan limiti alt alta; kullanıcı tahmini limit sanabilir. | Kartı "tahmin" diye adlandır, açıklamayı kartın içine al. | E |
| P6-6 | O | Görevlerde iki ayrı ekleme yolu (not kutusu + "New task" butonu); görünen tek satır eylemi "Delete". | Tek hızlı ekleme satırı + "Ayrıntılar…"; satırlara Düzenle/Sil. `TasksPage.tsx` | E |
| P6-7 | O | Raporlarda geliştirici notu gibi kalıcı bir bant; eylemi yok. | Yalnızca özet üretilemiyorsa göster, durum + eylem olarak yaz. `ReportsPage.tsx` | E |
| P6-8 | D | Görev kontrol kartlarında ~90px boş terminal önizlemesi. | Önizleme içeriği kadar küçülsün. | G |
| P6-9 | D | Oturumlar, Kullanım, Projeler, Yardım/Hakkında, güncelleme kartı, worktree ve docs diyaloglarında küçük düzen sorunları (etiketsiz istatistikler, buton boyları, sıralama). | Tek tek küçük düzeltmeler. | E |

**P7 — Asistan ve maskot**
| Kimlik | Önem | Sorun | Önerilen çözüm | Doğrulama |
|---|---|---|---|---|
| P7-1 | Y | Asistan alt bilgisi "Hiçbir şey kaydedilmez" diyor, hemen altında "sağlayıcı bu sohbetin kopyasını saklar" yazıyor. Gizlilik ifadesi kendi kendisiyle çelişiyor. | "Kotilo hiçbir şey kaydetmez" diye kapsamı daralt ve iki bilgiyi tek cümlede ver. `AssistantView.tsx`, `assistant.*.ts` | K |
| P7-2 | O | Hata kartında "Tekrar dene" yok; tek buton (Ayarlar → AI) sorunu çözmüyor. | "Tekrar dene" butonu; hata metninde CLI'ın adını ver. | E |
| P7-3 | O | Asistan kapalıyken ortadaki simge yükleniyor gibi görünüyor; başlıkta hâlâ sağlayıcı ve "Yeni sohbet" var. | Sabit, farklı bir simge; kullanılamazken başlık öğelerini gizle. | E |
| P7-4 | O | Maskotta "izin bekliyor" ile "hata" küçük boyutta neredeyse aynı (ikisi de kırmızı "!"). | Hataya ayrı simge (× veya üçgen), izin halkasını kalınlaştır. `mascotState.ts`, `mascot.css` | E |
| P7-5 | O | Maskotun üzerine gelince hiçbir açıklama çıkmıyor; tüm seçenekler yalnızca sağ tıkta. | Canlı durumu söyleyen ipucu ("2 ajan bekliyor – tıkla"). `MascotView.tsx` | E |
| P7-6 | D | Deck'ten verilen onay ana pencerede kaynak belirtmeden "Allowed once" diye görünüyor. | "Kotilo Deck'ten izin verildi" gibi kaynak ekle. | E |

**Ayrı açık madde (UX değil):** `e2e/usage.spec.ts` içindeki tepsi menüsü testi temiz `main` üzerinde de
düşüyor (tepside "Background service not running" çıkıyor). Bu değişikliklerden bağımsız; ayrıca bakılmalı.

## B. RAPOR (iş bittikten sonra)
### Sonuç
70 bulgunun büyük çoğunluğu uygulandı. Uygulama artık daha kolay keşfediliyor: sol menüde etiketler, çalışma alanı satırında "⋯" butonu ve ayarlarda arama var. Ajanlar sekmede adlarıyla görünüyor. Kırmızı yalnızca tehlikeli işlemlerde kullanılıyor ve onay pencereleri tek tip. Birim ve e2e testlerinin hepsi geçiyor.

### Yapılanlar
| Paket | Durum | Öne çıkanlar |
|---|---|---|
| P1 Hızlı düzeltmeler | Tamam | Komut paleti pencereye sığıyor. Kalıcı izin butonunun yazısı tam görünüyor. Çift odak çerçevesi kalktı. Türkçe tema adları doğru yazılıyor. Durum çubuğu sayaçları açıklamalı ve tıklanabilir. Ekran görüntüsü testindeki sayfa kayması düzeldi; Ayarlar artık yakalanıyor. |
| P2 Onay ve renk | Tamam | `ConfirmModal` ortak `Dialog` üzerinde ve `tone` seçenekli; "Mark reviewed" artık mavi. Yıkıcı satır butonları sakinleşti. Menülerde "Remove workspace" en sonda ve kırmızı. Asistan "Stop" butonu ve Pomodoro noktası nötr. |
| P3 Ana pencere | Tamam (P3-2 geri alındı) | Ajan sekmesi = ajan harfi + canlı başlık ya da ajan adı (aynı ad varsa " 2"). Ajan listesinde avatar ve ajan adı önde. Başlık şeridi durum değişince zıplamıyor, dar panelde tek satır. Zaman akışında Etkinlik alanı boşluğu dolduruyor. Diff açılınca görüntüleyici en az 480px'e genişliyor. Başlık butonları 26px. Dar composer'da "+" menüsü. |
| P4 Bulunabilirlik | Tamam (P4-3 kısmen) | Sol menüde etiketler. Çalışma alanı satırında "⋯" ve Shift+F10. Bağlam menüleri klavyeyle gezilebiliyor. Görev kontrolde bekleyen kartta "Ajana git" ya da "Kendi terminalinde yanıtla". Dosyalar başlığında "Docs" butonu. Pasif menü öğeleri nedenini söylüyor. Komut adları tutarlı, yıkıcı komutlar listenin sonunda. |
| P5 Ayarlar | Tamam (P5-2 kısmen) | "CLI bulundu" ile "Hook'lar kurulu" ayrıldı. Bildirim ayarları Bildirimler bölümünde ve hub kapalıyken de görünüyor. Kapat-tepsiye ve güncelleme kontrolü Görünüm > Genel'de. Ayarlarda filtre kutusu ve 3 gruplu menü. Görünüm'de "Mod" segmentli kontrol, hemen altında palet. Ana anahtar kapalıyken bağlı ayarlar soluk. Sihirbaz dış tıklamayla kapanmıyor. Kaydedilmemiş bölümde nokta ve not. |
| P6 Sayfalar | Tamam (P6-1 ve P6-3 kısmen, P6-8 yapılmadı) | Ortak sayfa başlığı ve filtre satırı. Açık temada ikincil butonlar beyaz. Stilli `Select`. Genel bakış'ta "Sizi bekleyenler" listesi (+N daha). Blok kartı "tahmin" olarak adlandırıldı. Görevler'de tek hızlı ekleme + "Ayrıntılar…" ve satır başına Düzenle/Sil. Raporlar notu yalnızca gerektiğinde. Plan limitleri yalnızca Genel bakış'ta. |
| P7 Asistan ve maskot | Tamam (P7-5 kısmen, P7-6 yapılmadı) | Gizlilik metni artık çelişmiyor ("Kotilo hiçbir şey kaydetmez, ama X kendi kopyasını saklar"). Hata kartında "Tekrar dene". Kapalı/kullanılamaz durumda sabit simge. Maskotta hata "×", izin "!" ve kalın halka. |

Ayrıca: `playwright.config.ts` portu `E2E_PORT` ortam değişkeninden okuyor (varsayılan 1430); böylece birden fazla checkout'ta e2e aynı anda çalışabiliyor. Sahte hub (`src/e2e/setup.ts`) kaydedilen ayarları artık hatırlıyor.

### Nasıl doğrulandı
- `npx tsc --noEmit -p .`: temiz.
- `npx vitest run`: 123 dosya, 1145 test, hepsi geçti.
- `npx playwright test` (tam paket): 157/157 geçti. Türkçe sol menü düzeltmesinden sonra Türkçe koyu ekranlar yeniden çekildi: 5/5.
- Ekran görüntülerine kendim baktım: izin kartı, bölünmüş panel, Genel bakış (TR), Ayarlar/Görünüm (TR), Görevler (TR), grup menüsü.
- Kod incelemesi: iki bağımsız Fable incelemesi yapıldı. Bulunan 2 önemli klavye gerilemesi ve 24 küçük madde düzeltildi.
- **Doğrulanmayan:** Gerçek uygulamada (Tauri penceresi, gerçek terminal ve ajanlar) elle deneme yapılmadı; testler sahte IPC ve sahte hub ile tarayıcıda çalışıyor. Açık temada kayıt sırasındaki mikrofon butonunu gösteren bir ekran görüntüsü yok.

### Değişen nesneler / dosyalar
`apps/desktop` altında 120'yi aşkın dosya (kaynak, testler, i18n, e2e). Yeni dosyalar: `src/app/ui/Select.tsx`, `IconButton.tsx`, `pageIcons.tsx`, `src/app/viewerRoom.ts`, `src/features/terminal/tabLabel.ts` (+ test), `src/features/settings/settingsSearch.ts`, `e2e/settings-ux.spec.ts`. Bu turdan önceki iki iş (composer dosya butonu, grup butonu) de aynı commit edilmemiş değişikliklerin içinde.

### Yapılmayanlar ve açık kalanlar
| Madde | Neden |
|---|---|
| P3-2 izin kartının terminalin altına alınması | Geri alındı, çünkü her izin isteğinde terminalin yeniden boyutlanması riskli (bkz. Kararlar). Kart terminalin son satırlarını hâlâ kapatabiliyor; daha iyi bir çözüm ayrı bir iş. |
| P4-3 Görev kontrolden doğrudan "İzin ver / Reddet" | İzin yanıtı panele bağlı bir yoldan gidiyor; onu güvenli biçimde paylaştırmak ayrı iş gerektiriyor. Şimdilik "Ajana git" var. |
| P5-2 otomatik kaydetme | Kapsam gereği yapılmadı; yalnızca "Kaydet gerekir" notu ve kaydedilmemiş noktası eklendi. AI bölümündeki uç nokta (endpoint) düzenlemeleri için nokta yok. |
| P6-8 Görev kontrol kart önizlemesinin küçülmesi | Önceliği düşük olduğu için yapılmadı. |
| P7-5 maskotta canlı ipucu ("2 ajan bekliyor") | Rust'tan gelen veride sayı yok; şimdilik sabit açıklama gösteriliyor. |
| P7-6 Deck onayının kaynağının gösterilmesi | Bu bilgi ön yüze ulaşmıyor. |
| Türkçe "izin bekliyor" rozetleri (grup ve çalışma alanı rozeti) | Soru bekleyen ajanları da sayıyor, "seni bekliyor" olmalı. Küçük bir metin düzeltmesi; bu turda kapsam dışında kaldı. |
| `e2e/usage.spec.ts` tepsi testi | Kararsız: bazı çalıştırmalarda düşüyor, temiz `main` üzerinde de. Ayrıca incelenmeli. |

### ⚠ Senden beklenenler (şimdi)
| # | Eylem | Neden | Aciliyet | İşi durduruyor mu? (Evet/Hayır) |
|---|---|---|---|---|
| 1 | `npm --prefix apps/desktop run tauri dev` ile uygulamayı açıp gerçek bir ajanla bakmak: izin kartı, sekme adları, sol menü, ayarlar araması, Genel bakış | Testler sahte veriyle çalışıyor; gerçek terminal ve ajan davranışı yalnızca elle görülebilir | Commit'ten önce | Hayır |
| 2 | Commit kararı: bu iş ile composer dosya butonu ve grup butonu tek commit mi, ayrı mı | Commit yalnızca sen isteyince yapılıyor | Uygun olduğunda | Hayır |

### Sonraki oturum için not
Değişiklikler commit edilmedi; baz `main` 55ec0c0. Açık maddeler yukarıdaki tabloda. Paralel e2e için `E2E_PORT` kullanılabilir. Alt ajanlar dosyaları CRLF satır sonuyla yazabiliyor; birleştirmeden önce satır sonlarını kontrol et.
