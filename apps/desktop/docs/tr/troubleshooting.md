# Sorun giderme

## Kurulumda ya da açılışta SmartScreen uyarısı

Geliştirme sürümleri **imzasızdır**. Windows SmartScreen, kurulumu ilk
çalıştırdığınızda (ve bazen uygulamayı ilk açtığınızda) "Windows bilgisayarınızı
korudu" / "Bilinmeyen yayımcı" uyarısı gösterir. **Ek bilgi**'ye, sonra **Yine de
çalıştır**'a tıklayın. Bu beklenen bir durumdur; indirmenin bozuk olduğu anlamına
gelmez.

## WebView2 eksik

`npm run tauri dev` pencere açamıyorsa ya da kurulu sürüm WebView2'den söz eden bir
hatayla açılmıyorsa
[Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)'ı
kurun. NSIS kurulumu eksikse onu normalde kendisi kurar (WebView2'nin "download
bootstrapper" kipini kullanır), ama kısıtlı bir bilgisayarda ya da çevrimdışı
kurulumda yine de eksik kalabilir.

## Arka plan servisi çalışmıyor

Uygulama arka plan servisine ulaşamadığında Genel bakış, Görev kontrol, Kullanım, Raporlar,
Projeler, Görevler, Dikte ve Ayarlar'ın servis bölümleri **Arka plan servisi
çalışmıyor** gösterir. Uygulama açılırken servisi başlatır ve durursa kısa bir
beklemeden sonra yeniden başlatır; bu yüzden açılıştan hemen sonra kısa süre görünen
bir uyarı normaldir. Uyarı kalıcıysa:

- Kotilo'ı yeniden başlatın.
- Servisin günlüğüne `%LOCALAPPDATA%\kotilo\hub\logs` (`hub-<tarih>.log`) ve
  uygulamanın günlüğüne (Ayarlar → Hakkında ve tanılama → **Günlük klasörünü aç**)
  bakın.
- Bu arada terminaller, dosyalar, görüntüleyici ve uygulamanın kendi izlediği ajan
  durumları çalışmaya devam eder; ajan bildirimleri uygulamanın kendi kuralına döner
  (bkz. [Bildirimler](user-guide.md#bildirimler)).

## Ajan durumları ya da izin kartı görünmüyor

- **Ayarlar → Ajanlar → Ajan entegrasyonları**'na bakın: ajan **Kurulu ve güncel**
  göstermeli. Değilse kurun ya da **Güncelle**'ye tıklayın.
- **Codex** yeni hook'ları ancak siz onayladıktan sonra çalıştırır. Codex'i açın,
  `/hooks` komutunu çalıştırın ve Kotilo kayıtlarını onaylayın. Bir güncelleme
  bunları değiştirdiğinde yeniden onay gerekir.
- Entegrasyon kurulmadan önce başlatılmış bir ajan eski hook ayarlarıyla çalışır; yeni
  bir oturum başlatın.
- İzin kartı arka plan servisine ihtiyaç duyar. Servis yoksa ajanı her zamanki gibi
  kendi terminalinde cevaplayın.

## Zaman akışında etkinlik ya da değişen dosya görünmüyor

- Etkinlik ve plan, yukarıdaki gibi ajanın entegrasyonundan gelir. Yalnızca arka plan
  servisinin belleğinde durur; servis yeniden başlayınca zaman akışı, ajan bir sonraki
  aracını kullanana kadar boş başlar.
- **OpenCode** araç çağrılarını yalnızca güncel eklentiyle bildirir: kartındaki
  **Güncelle**'ye (ya da **Onar**'a) tıklayın ve OpenCode'u yeniden başlatın.
- Plan yalnızca yapılacaklar listesini hook'lar üzerinden tutan ajanlarda görünür
  (Claude Code'un TodoWrite'ı).
- **Değişen dosyalar** için `git`'in `PATH`'te olması ve çalışma alanının bir git
  deposunda bulunması gerekir. Kotilo dışında yapılan bir commit ya da checkout bir
  sonraki dosya değişikliğinde ya da yenile düğmesiyle görünür.

## Kotilo taşındıktan ya da kaldırıldıktan sonra ajanda hook hataları

Kotilo'ın kurduğu ajan hook'ları sabit bir yolu çağırır:
`%LOCALAPPDATA%\kotilo\hub\bin\kotilo-hook.exe`. Bir ajan hook hatası
bildiriyorsa (örn. bu yol için "command not found"):

- **Kotilo'ı önce entegrasyonu kaldırmadan kaldırdıysanız**: Kotilo'ı yeniden
  kurun ve tekrar kaldırmadan önce Ayarlar → Ajanlar → Ajan entegrasyonları'nda
  **Kaldır**'ı kullanın ya da `kotilo-hook` geçen kayıtları ajanın ayar dosyasından
  elle silin (Claude Code için `~/.claude/settings.json`, Codex için
  `~/.codex/hooks.json`).
- **Hook yardımcısı eksik ya da eskiyse**: Kotilo'ı açın (arka plan servisi
  yardımcıyı açılışta yerine kopyalar) ve ajanın entegrasyon kartında **Güncelle**'ye
  tıklayın.
- Hook yardımcısı her zaman sessizce çıkar (çıkış kodu 0) ve hiçbir şey yazdırmaz; bu
  yüzden içindeki bir sorun ajanın çalışmasını durduramaz.

## "Ajanın ayar dosyası okunamıyor"

Kotilo, geçerli JSON olmayan ya da `hooks` bölümü beklenmedik biçimde olan bir ajan
ayar dosyasını değiştirmeyi reddeder. Hiçbir şey yazılmamıştır. Dosyayı bir editörde
düzeltin (ya da yanındaki `.kotilo-backup-<zaman>` kopyalarından birini geri
yükleyin) ve yeniden deneyin.

## Derleme `___chkstk_ms` çözümlenemeyen dış simge hatasıyla başarısız oluyor

`cargo build`/`cargo test`/`npm run tauri dev`/`npm run tauri build` bağlama adımında
`unresolved external symbol ___chkstk_ms` ya da `__isnan` gibi hatalarla başarısız
oluyorsa (genellikle `rusqlite`'ın paketlenmiş SQLite'ı bağlanırken): bu, hedef
`x86_64-pc-windows-msvc` iken `CC` ortam değişkeni bir GNU derleyicisine (örn.
MinGW kurulumundan `CC=gcc`) ayarlı olduğunda olur. Depo bunu `.cargo/config.toml`
ile zaten çözer: `CC`/`CXX` boşa zorlanır, böylece `cc` crate'i gerçek MSVC `cl.exe`'yi
bulur. Hatayı yine de alıyorsanız depo kökünden derlediğinizi (ki `.cargo/config.toml`
okunsun) ve kabuk profilinizdeki başka bir şeyin Cargo yapılandırmayı okuduktan sonra
`CC`/`CXX`'i yeniden ayarlamadığını kontrol edin. Ayrıntılı açıklama için depodaki
`docs/development.md` içinde "the `.cargo/config.toml` CC/CXX override" bölümüne
bakın.

## Günlükler ve durum nerede

| Konum | İçerik |
|---|---|
| `%LOCALAPPDATA%\kotilo\logs\kotilo.log` | Masaüstü uygulamasının günlük dosyası (Rust + arayüz). Açılışta döner, ~1 MB'lık en fazla 5 dosya tutulur. Ara sıra olan bir sorunu yeniden oluşturmadan önce Ayarlar → Hakkında ve tanılama → **Ayrıntılı günlük**'ü açın. |
| `%LOCALAPPDATA%\kotilo\diagnostics\` | **Tanılama topla** ile oluşturulan zip dosyaları (`kotilo-diagnostics-<zaman>.zip`, son 5 tanesi tutulur). |
| `%LOCALAPPDATA%\kotilo\hub\logs\` | Arka plan servisinin günlük dosyaları (`hub-<tarih>.log`, 14 gün). |
| `%LOCALAPPDATA%\kotilo\hub\` | Arka plan servisinin veritabanı, ayarları ve fiyat tablosu; bkz. [Veri konumları](user-guide.md#veri-konumları) |
| `%APPDATA%\kotilo\state.json` | Çalışma alanları, düzen, açık sekmeler, arayüz dili |
| `%APPDATA%\kotilo\settings.json` | Uygulama ayarları |
| `%APPDATA%\kotilo\state.json.corrupt` / `settings.json.corrupt` | Asıl dosya geçersiz JSON olduğu için Kotilo varsayılanlara döndüyse bulunur |
| `~/.claude/settings.json`, `~/.codex/hooks.json` ve `.kotilo-backup-<zaman>` kopyaları | Ajanların kendi ayarları ve Kotilo'ın yazmadan önce aldığı yedekleri |
| Chrome DevTools konsolu (depodaki `docs/development.md` içindeki uzaktan hata ayıklama ipucuyla) | Arayüz hataları/uyarıları; arayüz tarafındaki bir hata için en faydalı ayrıntı kaynağı |

## Sorun bildirme

Bir şey ters gittiğinde geliştiricilere gönderilecek asıl şey bir tanılama zip
dosyasıdır:

1. **Tanılama topla**: Ayarlar → Hakkında ve tanılama → **Tanılama topla** ya da komut
   paletinde **Yardım: Tanılama topla**. Zip dosyasını Gezgin'de gösterir ve yolunu
   panoya kopyalar
   (`%LOCALAPPDATA%\kotilo\diagnostics\kotilo-diagnostics-<zaman>.zip`).
   İçinde şunlar vardır: uygulama/işletim sistemi/WebView2 sürümleri, uygulamanın
   günlük dosyaları, `settings.json`'ın bir kopyası ve `state.json`'ın hassas olmayan
   kısımları (çalışma alanı ve açık dosya **yolları** hata ayıklama için vardır, dosya
   içerikleri asla yoktur) ve açık panellerin/ajanların bir özeti. Terminal çıktısı,
   dosya içerikleri ya da ajan konuşmaları **yoktur**. Windows kullanıcı adınız çoğu
   yolda maskelenir ama birkaçında yine de görünebilir; zip'in kendi `README.txt`
   dosyası içinde tam olarak ne olduğunu ve ne olmadığını açıklar, bu sizin için
   önemliyse paylaşmadan önce okuyun.
2. **Ne yaptınız**: adım adım (örn. "bir Claude Code sekmesi açtım → bir mesaj
   gönderdim → …").
3. **Ne bekliyordunuz** ve **bunun yerine ne oldu**.
4. **Her seferinde oluyor mu?** Olmuyorsa yaklaşık ne sıklıkta.
5. **İlgili ajan** ve sürümü (`claude --version`, `codex --version`); uygulama/işletim
   sistemi/WebView2 tarafı tanılama zip'inde zaten vardır.
6. Sorunun olduğu anın **ekran görüntüsü ya da kısa bir ekran kaydı**; ajanın başlık
   şeridi, Ajanlar paneli ve terminalin son satırları özellikle işe yarar.

Soruna göre ek dosyalar (bkz. [Günlükler ve durum nerede](#günlükler-ve-durum-nerede)):
- Arka plan servisi sorunları (kullanım, bildirimler, entegrasyonlar, izin kartı):
  `%LOCALAPPDATA%\kotilo\hub\logs` içindeki en son `hub-<tarih>.log`; tanılama
  zip'i bunu henüz içermiyor;
- Ajan hook sorunları: ajanın hook ayarlarından yalnızca Kotilo kayıtları
  (`~/.claude/settings.json` içindeki `hooks` bölümü ya da `~/.codex/hooks.json`) ve
  `%LOCALAPPDATA%\kotilo\hub\bin\` klasörünün listesi;
- **Kotilo açılmıyorsa** (kendi tanılamasını toplayamıyorsa):
  `%LOCALAPPDATA%\kotilo\logs` klasörünü elle zipleyip gönderin; ayrıca Olay
  Görüntüleyicisi → Windows Günlükleri → Uygulama altındaki `agenthub.exe` kayıtlarını
  ve WebView2 Runtime'ın kurulu olup olmadığını ekleyin.
