# Görsel cila turu (UI estetiği)

**Durum:** TAMAMLANDI
**Tarih:** 2026-11-26 (son güncelleme: 2026-11-26)
**Etkilenen yer:** `apps/desktop/src` (React arayüzü, `index.css`), `apps/desktop/src-tauri/src/platform/overlay_window.rs` (dikte penceresi düzeltmesi), `DESIGN_SYSTEM.md`, `docs/DECISIONS.md` (D-082). SAP'a yazma yok.

## A. BRIEF (işe başlamadan önce)

### Özet
UX gözden geçirmesi (`tasks/2026-11-26-ux-gozden-gecirme.md`) bozuk ve tutarsız olanı düzeltti; bu tur ise uygulamanın
daha göze hoş görünmesi için bilinçli görsel iyileştirme yapıyor. 3–4 ana ekran için 2–3 görsel yön üretilip önce/sonra
ekran görüntüleriyle kullanıcıya gösterilecek, seçilen yön tüm uygulamaya yayılacak.

### Arka plan
- **Tasarım dili** (`DESIGN_SYSTEM.md`): koyu, sessiz yüzeyler; vurgu yalnızca durum ve eylem için; Geist + Geist Mono;
  tüm renkler `index.css` içindeki CSS değişkenleri (token) üzerinden. Bu dil korunacak; köklü yeniden tasarım yok.
- **Yön (direction):** aynı ekranların farklı bir görsel ayarı (ör. yüzey derinliği, tipografi ölçeği, kart yoğunluğu).
  Yönler ayrı bir CSS katmanı olarak, `data-polish` özniteliğiyle açılıp kapanacak şekilde denenir; böylece aynı
  ekran üç yönle de yan yana çekilebilir. Seçilen yön sonra kalıcı token ve bileşen değişikliğine dönüşür, deneme
  katmanı silinir.
- **Ana ekranlar:** Genel bakış (Overview), Görev kontrol (Mission control), Çalışma alanı (Workspace: terminal + yan
  paneller), Ayarlar.

### Kapsam / Kapsam dışı
- Kapsam: renk/derinlik ayarları, tipografi hiyerarşisi, kart ve bölüm başlıkları, boş durumlar, küçük geçişler; koyu
  ve açık tema.
- Kapsam dışı: yeni özellik, marka/logo, düzen akışının değişmesi, terminalin kendi görünümü (ajanın arayüzü).

### Plan
- [x] 1. Mevcut ekran görüntülerini ve token'ları toplayıp Fable'a 3 görsel yön önerisi yaptır (somut token/CSS değerleriyle).
- [x] 2. Yönleri değerlendirip ortak iyileştirmeleri (her yönde olacak yapısal küçük düzeltmeler) ayır.
- [x] 3. Ortak iyileştirmeleri ve 3 yönü deneme katmanı olarak uygula; 6 ekranın önce/sonra görüntülerini çek (karşılaştırma sayfası: `apps/desktop/test-results/screens/polish/index.html`).
- [x] 4. Kullanıcıya göster, yön seçtir.
- [x] 5. Seçilen yönü kalıcı hale getir, deneme katmanını kaldır, `DESIGN_SYSTEM.md`'yi güncelle, testleri çalıştır.
- [x] 6. Raporu yaz.

### Riskler ve varsayımlar
- Görsel tercih öznel; bu yüzden karar kullanıcıda, öneriler görüntüyle sunulur.
- Kontrast kuralları (gövde metni ≥ 4.5:1, ikon ≥ 3:1) hiçbir yönde gevşetilmez.
- Kullanıcı arayüz fontunu değiştirebiliyor; yönler yalnızca varsayılan fontla değil, ölçek değişince de bozulmamalı.

### ⚠ Senden beklenenler (başlamadan önce)
| # | Karar / eylem | Neden gerekli | İşi durduruyor mu? (Evet/Hayır) | Cevap |
|---|---|---|---|---|
| 1 | Önce/sonra görüntülerinden bir yön seçmek | Görsel tercih senin | Evet (yalnızca 5. adımı) | |

### Kararlar
- 2026-11-26: Kullanıcı "başla" dedi; 1–4. adımlar onay beklemeden yapılıyor, kalıcı değişiklik (5. adım) yön seçilince.
- 2026-11-26: Fable 10 görsel sorun, 9 ortak düzeltme ve 3 yön önerdi: A "Katmanlı derinlik" (kartlar hafif gölgeyle yükselir, terminal ve önizleme içe gömük), B "Keskin editoryal" (gölge yok, ince çizgiler, daha küçük köşeler, sayılar düz yazı fontunda), C "Yumuşak sakin" (çerçevesiz, daha yuvarlak, daha ferah). Fable'ın önerisi A + B'nin çizgili bölüm başlığı. Ortak düzeltmeler (Görev kontrol önizlemesi, Genel bakış üst sırası, içerik azami genişliği, bölüm başlığı kontrastı, boş durumlar, tek aralıklı fontun yalnızca sayılarda kalması, ekran başına tek birincil buton) kalıcı olarak uygulanıyor; çünkü her yönde gerekiyorlar ve tasarım dilini değiştirmiyorlar. Palet renkleri `<html>` üzerinde satır içi yazıldığı için yönler yüzey rengini ezmiyor, yalnızca türetiyor (doğrulandı: `applyTheme.ts`).
- 2026-11-26: Sonnet ortak düzeltmeleri ve deneme katmanını (`src/polish.css`, yalnızca e2e modunda `?polish=a|b|c` ile açılıyor; `e2e/polish.spec.ts`) uyguladı; tsc temiz, vitest 1146/1146, tam e2e 166/167 (düşen tek test bilinen kararsız tepsi testi, tek başına geçti). Kendi kontrolümde Genel bakış'ta boşluğun yer değiştirdiğini gördüm (Toplamlar kartı uzun, kullanım kartının ortası boş kalıyordu); Bugün ve Bu hafta yan yana dizilerek düzeltildi.
- 2026-11-26: Kullanıcı önerilen yönle (A · Katmanlı derinlik) devam etmeyi seçti. A kuralları `index.css` sonuna ("Surface depth") kalıcı taşındı; deneme katmanı (`polish.css`, `main.tsx` anahtarı, `e2e/polish.spec.ts`) silindi. DESIGN_SYSTEM §3–§4 ve D-082 güncellendi.
- 2026-11-26: Kullanıcı, dikte penceresinde çalışırken ve sonrasında "Dictation ×" başlık çubuğunun çıkıp içeriği aşağı ittiğini bildirdi. Neden: pencere başlıksız oluşturulsa da başlık stili (`WS_CAPTION`) kalabiliyor ve bizim eklediğimiz araç penceresi stiliyle birleşince Windows küçük bir başlık çiziyor. Düzeltme: her gösterimde başlık ve çerçeve stilleri temizleniyor, çerçeve yeniden hesaplatılıyor (`overlay_window.rs`; maskot da aynı yolu kullanıyor).
- 2026-11-26: Kullanıcı, çalışmakta olan bir Claude Code oturumunun "Idle" göründüğünü bildirdi. Günlük (`kotilo.log`), her "Working→Working" mesaj gönderiminden kısa süre sonra kayıtsız bir Idle geçişi gösteriyordu. Neden: arka plan işi bekleyen ya da kuyruğa alınmış bir turda yeni mesaj gönderilince durum değişmediği için durum saati (`since_ms`) yenilenmiyordu. Mesajı yazarken basılan tuşlar bu yüzden "Esc ile iptal" yedeğini tetikliyordu (2 sn çıktı yoksa Idle). Düzeltme: `UserPromptSubmit` durum saatini her zaman yeniliyor (`agents/mod.rs`); iptal yedeğinin geçişleri artık günlüğe yazılıyor (`cancel-fallback state=…`). Yeni birim test eklendi.

## B. RAPOR (iş bittikten sonra)
### Sonuç
Uygulama "katmanlı derinlik" görsel diline geçti: kartlar hafif gölge ve üst ışıkla zeminden ayrılıyor, Görev kontrol önizlemesi içe gömük, bölüm başlıkları okunur ve çizgili. Her ekranda ortak düzen düzeltmeleri de yapıldı. Ayrıca dikte penceresindeki başlık çubuğu sorunu düzeltildi.

### Yapılanlar
| Alan | Değişiklik |
|---|---|
| Ortak düzeltmeler | Görev kontrol önizlemesi içeriği kadar (64–132px). Genel bakış'ta "Toplamlar" kartı (Bugün ve Bu hafta yan yana). İçerik en fazla 1180px. Bölüm başlıkları daha okunur. Boş durumlar simgeli ve ortalı. Tek aralıklı font yalnızca sayılarda (`.num`). Ayarlar > Ajanlar'da tek birincil buton. Uyarı kutuları daha sakin çerçeveli. Kart başlık satırları eşit yükseklikte. |
| A · Katmanlı derinlik | Kartlarda üst ışık, temas gölgesi ve kısa üst geçiş. Önizleme içe gölgeli. Bölüm başlığının sağında ince çizgi. Butonlarda 1px üst ışık. Sol menüde aktif öğe vurgu renginde (geniş modda solda çizgi). Tüm değerler palet token'larından türetiliyor. |
| Dikte penceresi | Her gösterimde başlık ve çerçeve stilleri temizleniyor, çerçeve yeniden hesaplanıyor. |

### Nasıl doğrulandı
- `npx tsc --noEmit -p .`: temiz. `npx vitest run`: 123 dosya, 1146 test geçti. `npx playwright test`: 159/159 geçti.
- Ekran görüntülerine baktım: Genel bakış (koyu), Ayarlar > Ajanlar (açık), Görev kontrol; ayrıca deneme aşamasında 6 ekranın 5 hali.
- Rust: yeni birim test (`chromeless` yalnızca başlık/çerçeve bitlerini siliyor) geçti; `cargo clippy --workspace --all-targets -- -D warnings` temiz.
- **Doğrulanmayan:** Dikte düzeltmesi gerçek masaüstünde denenmedi; dikte kısayolunu testten göndermek AGENTS.md kural 6 gereği yasak. Başka renk paletlerinde (Nord, Solarized vb.) ekran görüntüsü alınmadı; değerler palet token'larından türediği için sorun beklenmiyor.

### Değişen nesneler / dosyalar
`src/index.css`, `src/app/ui/{Card,PageHeader,Segmented,EmptyState}.tsx`, `src/features/{overview,mission,usage,settings,timeline,agents,viewer,worktrees}/…`, `src/app/i18n/{en,tr}.ts`, `src-tauri/src/platform/overlay_window.rs`, `DESIGN_SYSTEM.md`, `docs/DECISIONS.md`. Sol menü işi (`NavRail.tsx`, `layoutStore.ts`, `icons.tsx`, `routes.ts`, testler) da aynı commit edilmemiş değişikliklerin içinde.

### Yapılmayanlar ve açık kalanlar
| Madde | Neden |
|---|---|
| Açık temada derinlik zayıf | Açık temada yalnızca gölge taşıyor; bilerek abartılmadı. Beğenilmezse ayrı ayar. |
| B ve C yönleri | Kullanıcı A'yı seçti; deneme katmanı silindi. |
| Tepsi menüsü e2e testi | Bu turda geçti ama bilinen kararsız test (UX turunda not edildi). |

### ⚠ Senden beklenenler (şimdi)
| # | Eylem | Neden | Aciliyet | İşi durduruyor mu? (Evet/Hayır) |
|---|---|---|---|---|
| 1 | `tauri dev` ile dikteyi birkaç kez başlatıp başlık çubuğunun artık çıkmadığına bakmak (Rust değiştiği için uygulama yeniden derlenir) | Gerçek pencere davranışı testle görülemiyor | Commit'ten önce | Hayır |
| 2 | Yeni görünüme genel bir bakış (özellikle kendi paletin ve fontunla) | Görsel tercih; testler varsayılan paletle | Uygun olduğunda | Hayır |
| 3 | Commit kararı (sol menü + görsel cila + dikte düzeltmesi) | Commit yalnızca sen isteyince | Uygun olduğunda | Hayır |

### Sonraki oturum için not
Değişiklikler commit edilmedi; baz `main` eaa91ce. Deneme ekran görüntüleri `apps/desktop/test-results/screens/polish/` altında kaldı (git dışı, eski). Derinlik kuralları `index.css` sonunda "Surface depth" bölümünde; seçici `:is(.rounded-card, .rounded-sheet).bg-surface-2`.
