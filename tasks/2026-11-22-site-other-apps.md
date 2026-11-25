# Siteye "Other apps" sayfası

**Durum:** TAMAMLANDI
**Tarih:** 2026-11-22 (son güncelleme: 2026-11-22)
**Etkilenen yer:** `C:\Users\tr11677\dev\kotilo-site` reposu (GitHub: `kotilo-dev/kotilo-dev.github.io`), commit `9bd6dcc`. Kotilo uygulama reposunda değişiklik yok.

## A. BRIEF (işe başlamadan önce)
### Özet
kotilo.dev sitesine, Kotilo dışında başka platformlarda yayınlanan uygulamaları tanıtan bir "Other apps" sayfası eklenecek. Amaç, kullanıcının diğer işlerini tek yerden göstermek.

### Arka plan
- **kotilo.dev**: `kotilo-site` reposundaki statik site. Derleme adımı yok, GitHub Pages'te yayınlanıyor. Push edilen her değişiklik birkaç dakika içinde yayına girer.
- **Your Launcher**: Windows için klavyeyle kullanılan başlatıcı. Microsoft Store kimliği `9P98GW6RJHH2`.
- **Desktop Tiler**: PowerToys Command Palette için sanal masaüstü ve pencere döşeme eklentisi. Microsoft Store kimliği `9NDT24BZ55VK`. Lisansı MIT.
- **YourOmaLauncher**: Omarchy (bir Linux masaüstü dağıtımı) için başlatıcı eklentisi. Eklenti kimliği `io.github.xmsadik.youromalauncher`. Lisansı MIT.
- Mağaza sayfası **yayıncı adı**: "ABAPer". Kotilo markasından ayrı tutuldu.

### Kapsam / Kapsam dışı
- Kapsam: yeni `/apps/` sayfası, görseller, ana sayfanın menüsüne ve alt bilgisine link.
- Kapsam dışı: diğer ürün sayfalarının (desktop, kit, deck, newtab) menüleri. Bu sayfaların alt bilgisindeki "More tools from Kotilo" linki ana sayfaya gidiyor ve bu yeterli.

### Plan
- [x] 1. Üç mağaza sayfasından içeriği topla.
- [x] 2. Görselleri indir, WebP'ye çevir, siteye koy.
- [x] 3. Sayfayı mevcut tasarıma uygun yaz, CSS ekle.
- [x] 4. Ana sayfaya link ekle.
- [x] 5. Masaüstü ve telefon genişliğinde ekran görüntüsüyle kontrol et.
- [x] 6. Commit ve push (kullanıcı istedi).

### Riskler ve varsayımlar
- Microsoft Store ve Omarchy sayfaları JavaScript ile yükleniyor, bu yüzden içerik doğrudan okunamadı. İçeriği başka kaynaklardan aldım (ayrıntısı aşağıda).

### ⚠ Senden beklenenler (başlamadan önce)
Senden beklenen bir şey yok.

### Kararlar
- 2026-11-22: Görseller mağazadan bağlantıyla gösterilmek yerine siteye kopyalandı. Neden: sitenin dışarıya istek atmama ilkesi var.
- 2026-11-22: Your Launcher için lisans yazılmadı, yalnızca "free" yazıldı. Neden: mağaza verisinde lisans bilgisi yoktu.
- 2026-11-22: Kullanıcı "commit ve push" dedi. `9bd6dcc` push edildi.

## B. RAPOR (iş bittikten sonra)
### Sonuç
https://kotilo.dev/apps/ sayfası eklendi ve push edildi. Sayfada üç uygulama var: Your Launcher, Desktop Tiler ve YourOmaLauncher.

### Yapılanlar
- `apps/index.html`: Her uygulama için ikon, kısa tanıtım, özellik listesi, mağaza ve kaynak butonları, ekran görüntüleri. YourOmaLauncher bölümünde kurulum komutu da var. Alt bilgide gizlilik linkleri ve marka notu bulunuyor (Microsoft ve Omarchy ile bağlantı olmadığı belirtiliyor).
- `assets/img/apps/`: 2 ikon (PNG, 96 px) ve 5 ekran görüntüsü (WebP, en fazla 1440 px). Dönüştürme `kotilo/apps/desktop` içindeki sharp ile yapıldı.
- `assets/style.css`: Dosyanın sonuna `.page-intro`, `.app*` sınıfları ve iki mobil kırılım eklendi.
- `index.html`: Menüye ve alt bilgiye "Other apps" linki eklendi.

### Nasıl doğrulandı
- Site yerel bir HTTP sunucusunda açıldı, Playwright ile 1366 px ve 390 px genişlikte tam sayfa ekran görüntüsü alındı. Yatay kaydırma yok (`scrollWidth` görünüm genişliğine eşit) ve eksik dosya hatası (404) yok.
- Kurulum komutu ilk denemede satır sonunda kesiliyordu. Satıra sığacak şekilde kaydırma eklendi ve tekrar kontrol edildi.
- Yayındaki sayfa (push sonrası) açılıp kontrol edilmedi.

### Değişen nesneler / dosyalar
`kotilo-site`: `apps/index.html` (yeni), `assets/img/apps/*` (7 dosya, yeni), `assets/style.css`, `index.html`.

### Yapılmayanlar ve açık kalanlar
- Omarchy eklenti sayfası bizim okumamızda "Plugin not found" döndü. Buton yine de konuldu. Kullanıcı tarayıcıda kontrol etmeli.
- Your Launcher'ın lisansı bilinmiyor, sayfaya yazılmadı.

### ⚠ Senden beklenenler (şimdi)
| # | Eylem | Neden | Aciliyet | İşi durduruyor mu? (Evet/Hayır) |
|---|---|---|---|---|
| 1 | Omarchy linkini tarayıcıda aç | Katalog sayfası eklentiyi bulamıyor olabilir. Açılmıyorsa buton kaldırılır. | Düşük | Hayır |
| 2 | Your Launcher'ın lisansını söyle | Sayfaya eklemek için | Düşük | Hayır |

### Sonraki oturum için not
- Mağaza sayfaları JavaScript ile yüklendiği için içerik doğrudan okunamıyor. Microsoft Store verisi şu adresten JSON olarak alınabilir: `https://storeedgefd.dsx.mp.microsoft.com/v9.0/products/<ID>?market=US&locale=en-US&deviceFamily=Windows.Desktop`.
- Yeni bir uygulama eklemek için `apps/index.html` içindeki bir `<section>` kopyalanır, görseller `assets/img/apps/` klasörüne konur.
