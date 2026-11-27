# Web sitesi ana sayfasını stüdyo tanıtımına çevirme

**Durum:** TAMAMLANDI
**Tarih:** 2026-11-26 (son güncelleme: 2026-11-26)
**Etkilenen yer:** `C:\Users\tr11677\dev\kotilo-site` (kotilo.dev, GitHub Pages): `index.html`, `desktop/index.html`, `assets/style.css`, `assets/home.js`, yeni `assets/demo.js`, `README.md`. SAP'a yazma yok.

## A. BRIEF (işe başlamadan önce)
### Özet
kotilo.dev ana sayfası bugün yalnızca Kotilo Desktop'ı anlatıyor. Ana sayfayı beş ürünü birlikte gösteren bir "bağımsız yazılım stüdyosu" sayfasına çeviriyoruz. Canlı Mission Control demosu `/desktop/` sayfasının başına taşınıyor. Amaç, ürün ailesi büyüdüğü için (Desktop, Kit, Deck, New Tab, Shells) ana sayfanın hepsini adil biçimde tanıtması.

### Arka plan
- **Dış brief:** `~/Downloads/kotilo-website-redesign-brief.md`. Siteyi dışarıdan inceleyen birinin yazdığı yeniden tasarım notları. Bu oturumda incelendi; yorumlar aşağıdaki kararlara işlendi.
- **Site:** Düz HTML, CSS ve JS. Build adımı yok, GitHub Pages'ten yayınlanıyor. Bütün sayfalar ortak `assets/style.css` dosyasını kullanıyor; renkler ve tek köşe yuvarlaklığı dosyanın başında token olarak tanımlı.
- **Mission Control demosu:** Ana sayfanın sağ üstünde HTML ile çizilmiş, yaklaşık 9 saniyelik bir döngü. Bir ajan izin istiyor, ziyaretçi izin kartındaki düğmeye basabiliyor. Kodu `assets/home.js` içinde.
- **Ürünler ve lisanslar** (ürün sayfalarından doğrulandı): Desktop Apache-2.0; Kit, Deck, New Tab ve Zebar Pack MIT. "Other apps" (`/apps/`) Kotilo ailesinden değil; Microsoft Store uygulamaları ve bir Omarchy eklentisi.
- **Ekran görüntüsü temaları:** Desktop ve Deck Gruvbox Dark (sıcak), New Tab varsayılan koyu tema, Kit Catppuccin (mor). Kit görüntülerinin yeniden çekilmesi ayrı bir iş.

### Kapsam / Kapsam dışı
**Kapsam**
- Ana sayfanın (`/index.html`) yeni yapısı ve metinleri.
- Ana sayfaya özel CSS (yeni sınıflar), birkaç yeni token.
- Mission Control demosunun `/desktop/` başına taşınması (`assets/demo.js`).
- `README.md` içindeki ana sayfa ve sayfa tablosu satırlarının güncellenmesi.

**Kapsam dışı**
- Diğer ürün sayfalarının yeniden tasarımı. Ortak CSS'te değişen bir şey olursa yalnızca görünümlerinin bozulmadığı kontrol edilir.
- Kit ekran görüntülerinin yeniden çekilmesi.
- Yeni font dosyası (Fraunces italik). Vurgu bugünkü gibi iki tonla yapılır.
- Commit ve push. Yalnızca sen isteyince yapılır.

### Plan
- [x] 1. **Ana sayfa başlığı ve gezinme.** Marka solda. Sağda kısa gezinme: Products (`#products`), Approach (`#approach`), Other apps (`/apps/`), GitHub. Liste kısa tutulur, böylece 360 px genişlikte de açılır menü gerekmeden sığar; bugünkü sürümde mobilde yalnızca GitHub görünüyor. Ürün sayfalarının başlıkları değişmez.
- [x] 2. **Hero.** `<h1>Thoughtful tools <span class="soft">for the way you work.</span></h1>`. Altında somut vaat: "Free, open-source tools that run on your own machine", ardından beş ürünün kısa adları. "Kotilo is Finnish for a snail shell. Koti means home." satırı kalır. Düğmeler: **Explore products** (birincil, `#products`) ve **GitHub**. Alt satır: "Free · Open source · No account". Görsel: gerçek ekran görüntülerinden bir kolaj. En büyük pencere Desktop (`mission-control.webp`, uygulama penceresi çerçevesinde), arkada New Tab (`newtab/1-main.webp`, tarayıcı çerçevesinde), önde küçük Deck (`deck/deck-ops.webp`, monitör çerçevesinde). Brief üçüncü görsel için Kit ya da Shells öneriyor; Deck seçildi, çünkü Kit görüntüsü mor temada, Zebar görüntüsünün arka planı çok kalabalık. Arkada salyangoz kabuğu geometrisinden ince bir çizgi motifi var. Açılışta kısa bir giriş animasyonu oynar; azaltılmış hareket ayarında hiçbiri oynamaz. Mobilde kolaj dikey ve okunur bir düzene geçer.
- [x] 3. **Ürünler bölümü** (`#products`): "Tools for different moments." Desktop geniş öne çıkan kart. Sonra Kit ile New Tab yan yana, en son Deck ile Shells yan yana. Kit kartının yazı demosu ve New Tab kartının canlı saati kalır. Shells kartı `id="shells"` taşır, böylece eski `/#shells` bağlantıları çalışmaya devam eder. Her kartta ad, mevcut sayfadan alınmış tek cümle, platform ve lisans bilgisi ile "Explore Desktop →" gibi bir metin bağlantısı olur. Desktop kartında GitHub'dan çekilen son sürüm numarası görünür (`data-version`).
- [x] 4. **Yaklaşım bölümü** (`#approach`): "Software that respects your space." Dört madde: makinende çalışır; açık kaynak (Apache-2.0 ve MIT); hesap yok; az ve listelenmiş bağlantılar (güncelleme kontrolü, isteğe bağlı konuşma modeli indirme, senin kurduğun AI sağlayıcıları, Deck ve New Tab'da açtığın hava durumu gibi servisler). Son madde ürünlerin gizlilik sayfalarına bağlanır. "Hiçbir şey internete bağlanmaz" gibi genel bir iddia yazılmaz.
- [x] 5. **SSS** kalır, çünkü arama motorları için değerli. "Is it free?" cevabına Shells (Zebar Pack, MIT) eklenir.
- [x] 6. **"More from Kotilo."** Küçük, ikincil bir bölüm ve "Explore other apps →" bağlantısı.
- [x] 7. **Kalkanlar:** rakam şeridi, ajan durumu şeridi (ticker), ajan listesi ve "Give your agents a desk" kapanışı. Gerekçe: hepsi Desktop'a özgü ve `/desktop/` sayfasında karşılıkları zaten var ("Works with the agents you already use", "A closer look", indirme bölümü).
- [x] 8. **Altbilgi:** ürün bağlantıları, Other apps, GitHub, gizlilik bağlantıları ve bugünkü iki not. Telif satırı eklenmez, çünkü bir telif sahibi adı uydurmak gerekirdi.
- [x] 9. **Meta etiketleri:** başlık ve açıklama yeni konuma göre güncellenir; "no telemetry" vaadi korunur. OG görseli, favicon ve eski `#features` gibi bağlantıları `/desktop/`'a yönlendiren betik aynen kalır.
- [x] 10. **Desktop sayfası:** sağ üstteki statik `mission-control.webp` yerine canlı demo gelir. Demo çubuğunda "Demo" etiketi bulunur, böylece gerçek veri sanılmaz. Demo kodu `assets/home.js` içinden yeni `assets/demo.js` dosyasına taşınır. `home.js` içinde Kit demosu, New Tab saati, indirme düğmesi ve sürüm numarası kalır.
- [x] 11. **CSS:** yeni token'lar `--radius-lg` (yalnızca ana sayfa kartları ve kolaj çerçeveleri için), `--border-accent` ve `--surface-glass`. `--radius` (6 px) ve `--max` (1120 px) değişmez, çünkü bütün ürün sayfaları bunlara bağlı. Ana sayfaya ait olmayan eski CSS (ticker, proof, agent-row) silinir. Bunlardan biri başka bir sayfada kullanılıyorsa silinmez.
- [x] 12. **Doğrulama:** `python -m http.server` ile yerel sunucu açılır. Playwright ile ana sayfa ve `/desktop/` sayfasının 360, 390, 768, 1024 ve 1440 px ekran görüntüleri alınır. Diğer ürün sayfalarının 390 ve 1440 px görüntüleri alınır. Her sayfada yatay taşma kontrol edilir (`scrollWidth <= innerWidth`), konsol hataları okunur, bütün iç bağlantılar ve görsel yolları kontrol edilir. Ana sayfa klavyeyle gezilerek odak halkaları görülür.
- [x] 13. Rapor, `README.md` güncellemesi ve görev dizini.

### Riskler ve varsayımlar
- Kolajdaki üç görüntünün temaları farklı (Gruvbox, New Tab varsayılan teması). New Tab arkada ve küçük kaldığı için bunu kabul edilebilir sayıyorum; ekran görüntülerinde gözle kontrol edilecek.
- `/desktop/` sayfasının başlığı demoyla yükselir. Demo mobilde zaten tek sütuna geçiyor (bugünkü CSS).
- Eski `/#shells` ve `/#faq` bağlantıları korunuyor; `/#products` da korunuyor.
- Ortak `style.css` değişiyor. Bu yüzden ürün sayfaları ekran görüntüsüyle kontrol edilecek.

### ⚠ Senden beklenenler (başlamadan önce)
| # | Karar / eylem | Neden gerekli | İşi durduruyor mu? (Evet/Hayır) | Cevap |
|---|---|---|---|---|
| 1 | Ana sayfanın konumu | Bütün tasarım buna bağlı | Evet | Stüdyo, başlıkta "makinende çalışır" vaadi kalsın (2026-11-26) |
| 2 | Canlı demonun yeri | Ana sayfa ve Desktop sayfası düzeni buna bağlı | Evet | `/desktop/` başına (2026-11-26) |
| 3 | Kit ekran görüntülerinin Gruvbox Dark temasıyla yeniden çekilmesi | Görsel tutarlılık; Kit kartında yazı demosu kaldığı için bu işi durdurmuyor | Hayır | |

### Kararlar
- 2026-11-26: Konum soruldu. Seçenekler: (a) stüdyo ve somut vaat, (b) brief'teki gibi stüdyo ("curious minds"), (c) Desktop odaklı kalsın. Cevap: (a).
- 2026-11-26: Demonun yeri soruldu. Seçenekler: (a) `/desktop/` başı, (b) ana sayfada küçük, (c) kaldırılsın. Cevap: (a).
- 2026-11-26: İtalik vurgu yapılmayacak. Repoda Fraunces'in italik dosyası yok ve tarayıcının yapay italiği kötü görünür. Bugünkü iki tonlu başlık kullanılacak.
- 2026-11-26: İş Sonnet alt ajanına bu brief ile verilecek; ekran görüntülerini ve farkı ben inceleyeceğim (CLAUDE.md model katmanları).

## B. RAPOR (iş bittikten sonra)
### Sonuç
kotilo.dev ana sayfası artık beş ürünü birlikte tanıtan bir stüdyo sayfası. Canlı Mission Control demosu `/desktop/` sayfasının başında ve "Demo" etiketli. Değişiklikler yerelde, commit edilmedi.

### Yapılanlar
- **Ana sayfa (`index.html`):** kısa gezinme (Products, Approach, Other apps, GitHub) mobilde de tam görünüyor. Yeni başlık iki satır: "Thoughtful tools / for the way you work." Gerçek ekran görüntülerinden kolaj (Desktop, New Tab, Deck) ve arkada ince salyangoz kabuğu çizgisi var. Ürün kartları sırasıyla Desktop geniş, Kit ile New Tab, Deck ile Shells. Her kartta "Explore … →" bağlantısı, Desktop kartında GitHub'dan gelen sürüm numarası (şu an v0.11.0) bulunuyor. Ayrıca dört maddelik "Software that respects your space." bölümü, SSS ve küçük "More from Kotilo." bölümü eklendi. Meta etiketleri güncellendi.
- **Desktop sayfası:** statik ekran görüntüsünün yerine canlı demo geldi; demo kodu yeni `assets/demo.js` dosyasında.
- **`assets/home.js`:** yalnızca Kit yazı demosu, New Tab saati ve sürüm numarası kaldı. İşletim sistemine göre indirme düğmesi kodu silindi, çünkü ana sayfada indirme düğmesi artık yok.
- **`assets/style.css`:** yeni token'lar `--radius-lg`, `--border-accent`, `--surface-glass`, `--frame-bg`, `--bezel`; ana sayfaya özel sınıflar; kullanılmayan stiller (ticker, proof, strip, agent-row, closing) silindi. `--radius` ve `--max` değişmedi.
- **`README.md`:** sayfa tablosuna `/shells/` ve `/apps/` eklendi.
- Uygulamayı Sonnet alt ajanı yaptı. Ben ekran görüntülerini inceledim, geniş ekranda üç satıra bölünen başlığı iki satıra düzelttim ve satır sonlarını LF'ye çevirdim.

### Nasıl doğrulandı
- Playwright ile yerel sunucuya karşı: ana sayfa ve `/desktop/` 360, 390, 768, 1024 ve 1440 px'te; diğer altı sayfa 390 ve 1440 px'te kontrol edildi. Hiçbirinde yatay taşma yok. 22 çalıştırmada konsol hatası ve başarısız istek sayısı 0.
- Sekiz sayfadaki bütün iç bağlantılar ve görsel yolları 200 döndü; bütün çapalar (`#products`, `#shells`, `#faq` …) hedef sayfada var.
- Azaltılmış hareket ayarında ana sayfada ve `/desktop/` sayfasında çalışan animasyon sayısı 0.
- Klavye sırası: marka, gezinme, iki hero düğmesi, kart bağlantıları; odak halkası görünüyor.
- Başlık düzeltmesinden sonra satır sayısı ölçüldü: 390–1440 px arasında 2 satır, 360 px'te 3 satır.
- Ekran görüntülerini kendim inceledim: ana sayfa 1440 ve 390 px, `/desktop/` 1440 px.
- **Doğrulanmayanlar:** dış bağlantılar (GitHub, mağazalar) tek tek açılmadı. Diğer ürün sayfalarının ekran görüntülerine alt ajan baktı, ben bakmadım; taşma ve bağlantı kontrolleri ise geçti. Gerçek tarayıcıda gözle bakılmadı.

### Değişen nesneler / dosyalar
`kotilo-site`: `index.html`, `desktop/index.html`, `assets/style.css`, `assets/home.js`, `assets/demo.js` (yeni), `README.md`. Ekran görüntüleri: oturum geçici klasöründe `scratchpad\site-check\shots\`.

### Yapılmayanlar ve açık kalanlar
- Kit ekran görüntüleri hâlâ Catppuccin temasında. Ana sayfada Kit kartı yazı demosu gösterdiği için orada görünmüyor; Kit sayfasında görünüyor.
- Kolajda New Tab görüntüsünün çoğu Desktop penceresinin arkasında kalıyor; yalnızca saat kısmı görünüyor. Planlanan katmanlama buydu, istenirse kaydırılabilir.
- Hero'daki "Kotilo is Finnish for a snail shell" satırı artık italik değil; diğer sayfalarda italik kaldı.
- Commit ve push yapılmadı.

### ⚠ Senden beklenenler (şimdi)
| # | Eylem | Neden | Aciliyet | İşi durduruyor mu? (Evet/Hayır) |
|---|---|---|---|---|
| 1 | Siteye yerelde göz at (`kotilo-site` içinde `python -m http.server`, ardından http://localhost:8000) | Gerçek tarayıcıda, gerçek ekranında görmeni istiyorum | Commit'ten önce | Hayır |
| 2 | Commit ve push kararı | Push edilince GitHub Pages siteyi hemen yayınlar | Uygun olduğunda | Evet (yayın için) |
| 3 | Kit ekran görüntülerinin Gruvbox Dark ile yeniden çekilmesi | Görsel tutarlılık | Düşük | Hayır |

### Sonraki oturum için not
- Değişiklikler `kotilo-site` çalışma ağacında, commit edilmedi.
- Kontrol betiği: oturum geçici klasöründe `scratchpad\site-check\check.cjs`. Playwright'ı `kotilo/apps/desktop/node_modules` içinden kullanıyor, sunucu portu 8765. Geçici klasör silinebilir.
