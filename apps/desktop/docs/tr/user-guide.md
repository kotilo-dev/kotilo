# Kullanım kılavuzu

Kotilo, yapay zekâ kodlama ajanları için bir masaüstü çalışma alanıdır: ajanların
canlı durumunu gösteren gerçek terminaller, bir karttan cevaplayabileceğiniz izin
istekleri, kullanım, maliyet ve plan limitleri, proje ilerlemesi, kişisel görevler ve
dikte geçmişi.

Bu kılavuz ([Kısayollar](keybindings.md) ve [Sorun giderme](troubleshooting.md) ile
birlikte) uygulamanın içinde de bulunur: istediğiniz zaman **F1**'e basın ya da durum
çubuğundaki **?** düğmesine tıklayın; depoya erişmeniz gerekmez. Yardım, uygulamanın
diline (Türkçe ya da İngilizce) göre açılır.

## Kurulum

Kotilo kullanıcı başına kurulan bir NSIS kurulum dosyasıyla gelir:
`agent-hub_<sürüm>_x64-setup.exe` (örneğin `agent-hub_0.1.0_x64-setup.exe`).

- **Yönetici hakkı gerekmez.** Kurulum kullanıcı kipinde çalışır
  (`installMode: currentUser`).
- `%LOCALAPPDATA%\kotilo` klasörüne kurar; Başlat menüsü ve masaüstü kısayolları ile
  kullanıcıya özel (`HKCU`) bir kaldırma kaydı oluşturur.
- **WebView2 Runtime** gerekir. Çoğu Windows 11 bilgisayarda zaten vardır; yoksa
  kurulum onu indirip kurar (WebView2'nin "download bootstrapper" kipini kullanır).
- Sürümler **imzasız** olduğu için Windows SmartScreen, kurulumu (ve belki uygulamayı)
  ilk çalıştırdığınızda "Bilinmeyen yayımcı" uyarısı gösterir. **Ek bilgi**'ye, sonra
  **Yine de çalıştır**'a tıklayın.

### Güncelleme

Yeni kurulum dosyasını indirip çalıştırın; önce kaldırmanız gerekmez. Verileriniz
(çalışma alanları, ayarlar, terminal düzeni, kullanım geçmişi) korunur, çünkü program
dosyalarının dışında durur (bkz. [Veri konumları](#veri-konumları)).

### Kaldırma

1. **Kaldırmadan önce** kurduğunuz ajan entegrasyonlarını kaldırın: **Ayarlar →
   Ajanlar** sayfasını açın ve **Ajan entegrasyonları** altında her ajan için
   **Kaldır**'a tıklayın. Kaldırma programı ajanlarınızın ayar dosyalarına
   *dokunmaz*; bkz. [Ajan entegrasyonları](#ajan-entegrasyonları).
2. Kaldırma programını çalıştırın (Başlat menüsünden ya da Windows Ayarları'ndaki
   "Uygulamalar" bölümünden).

Kaldırma programı uygulamayı, kısayollarını ve kayıt defteri girdisini siler. Veri
klasörleriniz kalır (bkz. [Veri konumları](#veri-konumları)); tamamen temiz bir
kaldırma istiyorsanız bunları kendiniz silin. 1. adımı atladıysanız
`%LOCALAPPDATA%\kotilo\hub\bin` içindeki hook yardımcısı ajanlarınızın hook'larının
hata vermesini önler: her zaman sessizce çıkar.

## Veri konumları

| Dosya | İçerik |
|---|---|
| `%APPDATA%\kotilo\state.json` | Çalışma alanı listesi, etkin çalışma alanı, ağaçta açık klasörler, görüntüleyicide açık sekmeler, panel/pencere düzeni, açık terminal sekmeleri, arayüz dili. Kısa bir gecikmeyle, atomik olarak (geçici dosya + yeniden adlandırma) yazılır. |
| `%APPDATA%\kotilo\settings.json` | Uygulama ayarları ([Ayarlar](#ayarlar) sayfasındaki Görünüm, Editör, Terminal, Dosyalar, Ajanlar, Hakkında) ve mesaj kutusunun kayıtlı istemleri. `state.json`'dan ayrı tutulur; bir ayar yazımı düzeninizi bozamaz, tersi de olmaz. |
| `%LOCALAPPDATA%\kotilo\logs\kotilo.log` | Masaüstü uygulamasının kendi günlük dosyası; bkz. [Günlükler ve tanılama](#günlükler-ve-tanılama). |
| `%LOCALAPPDATA%\kotilo\diagnostics\` | **Tanılama topla** ile oluşturulan zip dosyaları. |
| `%LOCALAPPDATA%\kotilo\hub\` | Arka plan servisinin verileri: `hub.db` (oturumlar, kullanım, görevler, dikte geçmişi), `settings.json` (bildirim, kullanım, proje, görev ve dikte ayarları), `pricing.json`, `logs\` ve `bin\kotilo-hook.exe` (ajanlarınızın hook'larının çağırdığı yardımcı). |

`state.json` ya da `settings.json` bozulursa (örneğin elle düzenlenip geçersiz JSON
olursa) Kotilo çökmek yerine varsayılanlarla açılır ve bozuk dosyayı
`state.json.corrupt` / `settings.json.corrupt` olarak yeniden adlandırır; hiçbir şey
sessizce kaybolmaz.

Prompt'lar, yanıtlar ve dikte edilen ses hiçbir zaman saklanmaz; yalnızca sayılar ve
üst veriler tutulur (örneğin prompt uzunluğu, token sayıları, araç adları). Tek istisna,
[mesaj kutusunda](#mesaj-kutusu) kendinizin kaydettiği istemlerdir. Ajanların
[Zaman akışı](#zaman-akışı) için son araç etkinliği yalnızca arka plan servisinin
belleğinde tutulur.

## Günlükler ve tanılama

Masaüstü uygulaması `%LOCALAPPDATA%\kotilo\logs\kotilo.log` dosyasına dönen bir
günlük yazar (her açılışta döner, ~1 MB'lık en fazla 5 dosya tutulur). Açılış/kapanış,
terminal başlatma hataları, hook hataları ve arayüz hata mesajları gibi şeyleri
kaydeder; terminal girdi/çıktısını, pano içeriğini, dosya içeriklerini ya da ajan
prompt/yanıtlarını asla kaydetmez. Arka plan servisi kendi günlük dosyalarını
`%LOCALAPPDATA%\kotilo\hub\logs` klasöründe tutar (14 gün).

Bir sorun olduğunda **Tanılama topla**'yı kullanın (Ayarlar → Hakkında ve tanılama
ya da komut paletinde **Yardım: Tanılama topla**). Günlükleri ve hassas olmayan bazı
uygulama durumlarını `%LOCALAPPDATA%\kotilo\diagnostics\` altında bir zip dosyasına
toplar (son 5 tanesi tutulur). Bununla ne yapacağınız için bkz.
[Sorun bildirme](troubleshooting.md#sorun-bildirme). **Yardım: Günlük klasörünü aç**
(ya da Hakkında bölümündeki düğme) günlük klasörünü doğrudan Gezgin'de açar.

Beklenmeyen bir çökme boş bir pencere yerine, kendi **Yeniden yükle** ve **Tanılama
topla** düğmeleri olan bir kurtarma ekranı gösterir. **Yeniden yüklemek çalışan tüm
terminalleri ve ajanları kapatır**; bunlar kaldığı yerden devam etmez, yeniden başlar.

## Gezinme

En soldaki şerit uygulamanın ekranları arasında geçiş yapar. Her düğmenin ipucunda
kısayolu yazar; `Alt+1` … `Alt+9` her yerden (terminal odaktayken bile) çalışır:

| Kısayol | Ekran | Ne işe yarar |
|---|---|---|
| `Alt+1` | Çalışma alanı | Dosyalar, terminaller, ajanlar, görüntüleyici; bkz. [Düzen ve paneller](#düzen-ve-paneller) |
| `Alt+2` | Genel bakış | Etkin blok, bugün ve bu hafta, limitler, oturum özeti, proje ilerlemesi |
| `Alt+3` | Görev kontrol | Canlı her ajan oturumu son çıktısıyla bir kutucukta; bkz. [Görev kontrol](#görev-kontrol) |
| `Alt+4` | Kullanım | Günlük token/maliyet, 5 saatlik bloklar, dağılımlar |
| `Alt+5` | Raporlar | Günlük özet, beklemeler, dışa aktarılabilir maliyet raporları |
| `Alt+6` | Projeler | Todo dosyası ilerlemesi, git durumu, görünen adlar ve müşteriler |
| `Alt+7` | Görevler | Kendi notlarınız ve yapılacaklarınız |
| `Alt+8` | Dikte | Konuşma modelleri ve dikte geçmişi |
| `Alt+9` | Ayarlar | Tüm ayarlar (şeridin en altında) |

`Ctrl+1` … `Ctrl+9` çalışma alanları arasında geçiş için ayrılmıştır.

## Arka plan servisi

Kullanım, maliyet, limitler, bildirimler, projeler, görevler ve ajan entegrasyonları
Kotilo'ın arka plan servisi tarafından yürütülür. Uygulama açılırken servisi
(gizli olarak) başlatır, durursa yeniden başlatır. Servise ulaşılamadığında bu
ekranlarda **Arka plan servisi çalışmıyor** yazar; terminaller, dosyalar ve
görüntüleyici çalışmaya devam eder. Servis yalnızca `127.0.0.1` üzerinden dinler ve
yalnızca erişim anahtarını (kendi veri klasöründe durur) taşıyan istekleri kabul eder.

## Düzen ve paneller

Çalışma alanı ekranı üç ana sütuna ayrılır: **Çalışma alanları**/**Ajanlar** (sol),
**Terminal** (orta), **Görüntüleyici** (sağ); altta da bir durum çubuğu vardır. Sol
sütun kendi içinde dikey olarak Çalışma alanları (üst) ve Ajanlar (alt) olarak
bölünür. En sağda [Zaman akışı](#zaman-akışı) şeridi durur.

- Boyutlandırmak için sütunlar (ya da Çalışma alanları/Ajanlar) arasındaki ince
  ayırıcıları sürükleyin. Boyutlar yeniden açılışta korunur.
- Bir sütunu tümüyle aç/kapat: `Ctrl+B` (sol sütun), `Ctrl+J` (Terminal),
  `Ctrl+Shift+U` (Görüntüleyici). Gizlenen sütun arka planda çalışmaya devam eder
  (gizli bir terminal işlemini ve geçmişini korur); yeniden açınca yalnızca görünür
  olur.
- Pencere konumunu, boyutunu ve her panelin boyutunu/görünürlüğünü hatırlar.

## Çalışma alanları

**Çalışma alanı eklemek:** Çalışma alanları panelinin başlığındaki **+**'ya tıklayın
(klasör seçici açılır; birden çok klasör seçebilirsiniz), Gezgin'den pencereye bir
klasör sürükleyin ya da komut paletinde **Çalışma alanları: Çalışma alanı ekle…**'yi
kullanın. Aynı klasör iki kez eklenemez. Projeler ekranında henüz çalışma alanı
olmayan bir projenin **Çalışma alanı olarak ekle** düğmesi vardır.

**Çalışma alanları arasında geçiş:** çalışma alanının adına ya da yanındaki **○/●**
düğmesine tıklayın (● = etkin) veya listedeki N'inci çalışma alanına geçmek için
`Ctrl+1`…`Ctrl+9`'a basın. Ağaç yalnızca *etkin* çalışma alanı için açık gösterilir;
başka birine geçince arayüzde kapanır (açık klasörleri hatırlanır, geri dönünce
yeniden açılır). Terminaller ve görüntüleyici sekmeleri çalışma alanına özeldir ve
başka birine geçtiğinizde arka planda açık kalır.

**Dosya ağacı:**
- Klasörler dosyalardan önce, büyük/küçük harf ayırmadan alfabetik sıralanır.
- Bir dosyaya tek tıklamak onu seçer (görüntüleyici değişmez); çift tıklamak (ya da
  Enter) onu *italik* bir önizleme sekmesinde açar; bu sekme bir sonraki önizlediğiniz
  dosyayla değişir. `Ctrl`+tıklama (ya da `Ctrl+Enter`) kalıcı (italik olmayan) bir
  sekmede açar. Önizleme sekmesinde yazmaya başlamak onu otomatik olarak sabitler.
- Klavye: `↑`/`↓` seçimi taşır, `←`/`→` kapatır/açar, `Enter` açar (çift tıklama
  ile aynı; `Ctrl+Enter` = yeni sabit sekme), `F2` yeniden adlandırır, `Delete` siler.
- Bir dosyaya ya da klasöre sağ tıklayınca: Yeni dosya, Yeni klasör, Yeniden adlandır,
  Sil (Geri Dönüşüm Kutusu'na taşır), Yolu kopyala, Göreli yolu kopyala, Gezginde
  göster, **Burada terminal aç** (o klasörde ya da dosyanın klasöründe yeni terminal
  sekmesi) ve **Panodaki görseli buraya kaydet**.
- Bir çalışma alanının kök satırına sağ tıklayınca: Etkinleştir, Yeni dosya/klasör,
  Yeniden adlandır (yalnızca görünen ad; diskteki klasöre dokunmaz), Kaldır (diskten
  hiçbir şey silmez; kaydedilmemiş dosyalar varsa önce kaydetmeyi/atmayı sorar),
  Gezginde aç, Panodaki görseli buraya kaydet, Yukarı taşı/Aşağı taşı.
- **Varsayılan olarak gizlenenler:** `.git`, `node_modules`, `dist`, `target`,
  `.DS_Store`. Listeyi Ayarlar → Dosyalar'dan düzenleyin. Desenler her derinlikte
  uygulanan **yalnızca ada bakan glob**'lardır (örn. `*.log`); `/` ya da `\` içeren
  veya `!` ile başlayan desen reddedilir. Deponuzun `.gitignore` dosyalarının (ve
  `.git/info/exclude`) yok saydığı her şeyi de gizlemek için **.gitignore'a uy**'u
  açın; çalışma alanı kökünden aşağıya doğru bakılır, kökün üstündeki `.gitignore`
  dosyaları dikkate alınmaz.
- Ağaç, dosyalar diskte değiştikçe (bir ajan oluşturduğunda, git işlemlerinde vb.)
  genellikle bir saniye içinde kendini günceller.
- Panel başlığındaki **süzme kutusu**: etkin çalışma alanında bulanık arama için dosya
  adının bir kısmını yazın; bir sonuca tıklamak onu ağaçta gösterip seçer, `Esc`
  kutuyu temizler.
- **Panodaki görseli buraya kaydet**: bir ekran görüntüsü aldıktan sonra (örn.
  `Win+Shift+S`) bir klasöre (ya da çalışma alanı köküne) sağ tıklayıp bu komutu
  seçin veya ağaçta bir klasör seçiliyken `Ctrl+V`'ye basın. Görsel
  `screenshot-YYYYMMDD-HHMMSS.png` olarak kaydedilir (aynı saniyede çakışırsa `-2`
  gibi bir ek alır), ağaçta seçilir ve çalışma alanına göre yolu panoya kopyalanır
  (görsel yapıştırmayı kabul etmeyen bir ajana yolu yapıştırabilmeniz için); bunu
  Ayarlar → Dosyalar'dan kapatabilirsiniz. Panoda görsel yoksa "Panoda görsel yok"
  uyarısı çıkar ve hiçbir şey yazılmaz.

## Görüntüleyici

- Sekmeler çalışma alanına özeldir; kaydedilmemiş bir sekmede `●` noktası görünür. Bir
  sekmeyi kapatmak için orta tıklayın ya da `×`'e tıklayın.
- **Önizleme ve sabit sekmeler:** önizleme sekmesi italik gösterilir ve bir sonraki
  önizlediğiniz dosyayla değişir; sabit sekme açık kalır. Önizleme sekmesinde
  düzenleme yapmak onu otomatik olarak sabitler.
- **Metin/kod dosyaları** Monaco'da açılır: `Ctrl+S` kaydeder. Kodlama (UTF-8, UTF-8
  BOM, UTF-16 LE/BE ya da salt okunur yedek olarak ANSI) ve satır sonları (LF/CRLF)
  açılışta algılanır ve kaydederken aynen korunur; CRLF bir dosyayı düzenleyip
  kaydetmek onu LF'ye çevirmez. Karışık satır sonları olan bir dosya uyarı gösterir ve
  baskın satır sonuyla kaydedilir. `Shift+Alt+F` JSON (Monaco'nun kendi
  biçimlendiricisi) ve XML biçimlendirir.
  - 5 MB'tan büyük dosyalar ve kodlaması kayıpsız çözülemeyen dosyalar nedenini
    açıklayan bir uyarıyla **salt okunur** açılır; salt okunur bir dosyada `Ctrl+S`
    kaydetmek yerine bildirim gösterir. 50 MB'tan büyük dosyalar metin olarak hiç
    açılmaz; görsel/PDF/diğer ikili okumalar 100 MB ile sınırlıdır.
  - Dosya diskte değişirse (örn. bir ajan düzenlerse): yerel değişikliği olmayan belge
    sessizce yeniden yüklenir; kaydedilmemiş değişikliği olan belge **Yeniden yükle**
    (düzenlemelerinizi atar), **Benimkini tut** (sonraki kayıtta sizin sürümünüz
    yazılır) ve **Karşılaştır** (diskteki sürümle yan yana fark) seçenekleri olan bir
    şerit gösterir.
- **Markdown** (`.md`): sekme şeridindeki kip seçici **Düzenle** / **Önizleme** /
  **Bölünmüş** arasında geçiş yapar. Önizleme GitHub tarzı Markdown'ı (tablolar, görev
  listeleri) sözdizimi renklendirilmiş kod bloklarıyla gösterir; göreli görsel yolları
  çalışma alanına göre çözülür; göreli bir `.md` bağlantısı görüntüleyicide açılır,
  `#bağlantı` o başlığa kaydırır, `https://` bağlantıları varsayılan tarayıcınızda
  açılır. `Ctrl+Shift+M` Düzenle/Önizleme arasında geçiş yapar.
- **HTML** (`.html`/`.htm`): Kaynak (Monaco) / Önizleme kipleri. Önizleme, betikleri
  varsayılan olarak kapalı, korumalı bir iframe'de gösterilir (bir onay kutusu o sekme
  için betikleri açar); göreli CSS/görsel başvuruları dosyanın klasörüne göre çözülür.
- **Görseller** (png, jpg, jpeg, gif, webp, bmp, ico) ve **SVG**: Sığdır / %100 /
  yakınlaştırma (`Ctrl`+fare tekerleği ya da +/− düğmeleri), saydamlığın arkasında dama
  deseni ve genişlik × yükseklik ile dosya boyutunu gösteren bir alt bilgi. SVG'nin
  ayrıca Kaynak kipi (düz metin/XML düzenleme) vardır.
- **PDF**: sayfalar tembel yüklenerek tek tek gösterilir; sayfa numarası kutusu,
  yakınlaştırma düğmeleri, Genişliğe sığdır ve `Ctrl+F` ile belge içi metin araması
  (eşleşen sayfalar arasında atlar; sayfa içinde vurgulama yoktur).
- **Diğer her şey** (ikili dosyalar, `.exe`, `.lnk`, tanınmayan türler vb.): "Önizleme
  yok" ve **Varsayılan uygulamayla aç** düğmesi (çalıştırılabilir dosyalar/kısayollar
  için gösterilmez; onlar için yalnızca Gezginde göster sunulur).
- Kaydedilmemiş bir sekmeyi kapatmak, kaydedilmemiş sekmesi olan bir çalışma alanını
  kaldırmak ya da kaydedilmemiş sekme varken uygulamayı kapatmak önce kaydetmeyi ya da
  atmayı sorar.

## Terminaller

- Her çalışma alanının kendi terminal sekmeleri vardır. **+** düğmesi (yanındaki
  **▾** açılır menüsüyle) varsayılan kabuğunuzla ya da algılanan herhangi bir profille
  (PowerShell 7 `pwsh`, Windows PowerShell, `cmd`, Git Bash, WSL; hangileri
  kuruluysa) yeni bir sekme açar. **Yeni ajan ▶** menüsü, ayarladığınız ajan
  komutlarından birini (varsayılan: `claude`, `codex`) çalıştıran bir sekme başlatır;
  Ayarlar → Ajanlar'da ajan komutu listesini boşaltırsanız gizlenir.
- **Ajan sekmeleri uygulama yeniden açılınca kendiliğinden başlamaz.** Geri yüklenen
  bir ajan sekmesi ajanı hemen başlatmak yerine "`<komut>` başlat / Yalnızca kabuğu
  başlat" seçeneklerini gösterir.
- Çalışma alanı ya da ekran değiştirmek arka plandaki terminalleri durdurmaz; çalışmaya
  devam eder ve geçmişlerini (10.000 satır) korurlar.
- **Kopyala/yapıştır** Windows Terminal kurallarını izler: seçim varsa `Ctrl+C`
  kopyalar (ve seçimi kaldırır), yoksa SIGINT (kesme) gönderir; `Ctrl+V` yapıştırır;
  `Ctrl+Shift+C`/`Ctrl+Shift+V` seçimden bağımsız olarak her zaman kopyalar/yapıştırır.
  Sağ tıklama seçim varsa kopyalar, yoksa yapıştırır. Fareyle seçileni otomatik olarak
  panoya kopyalamak için Ayarlar → Terminal'de **Seçince kopyala**'yı açın.
- **Yapıştırma uyarısı:** düz bir kabuğa (claude/codex gibi "bracketed paste"
  kullanan tam ekran bir TUI'ye değil) çok satırlı metin yapıştırmak "Terminale N satır
  yapıştırılsın mı?" onayını gösterir: Enter yapıştırır, Esc vazgeçer; bir de "Bir daha
  sorma" kutusu vardır. Ayarlar → Terminal'den kapatabilirsiniz.
- **Tıklanabilir bağlantılar:** terminal çıktısındaki bir dosya yoluna (örn.
  `src/foo.ts:42`, satır numarası dahil) `Ctrl`+tıklayınca görüntüleyicide o satırda
  açılır; bir `https://` adresine `Ctrl`+tıklayınca tarayıcınızda açılır. Fareyle
  üzerine gelince bir ipucu hangisi olduğunu söyler.
- Terminal içi arama: `Ctrl+Shift+F`.
- Kabuk dışında hâlâ çalışan bir işlemi olan sekmeyi kapatmak onay ister ve çalışan
  işlemleri listeler.

### Yan yana iki bölme

Terminal paneli iki sekmeyi yan yana gösterebilir; örneğin aynı anda çalışan iki ajan.
Bölmenin yolları:

- Bir sekmeye sağ tıklayıp **Sağa böl**'ü seçin: o sekme sağ yarıda açılır, etkin sekme
  solda kalır.
- Bir sekmeyi terminal alanının sağ yarısına sürükleyin (sürüklerken "Sağda açmak için
  buraya bırakın" alanı çıkar).
- Bir ajanın başlık şeridindeki bölme düğmesine tıklayın: o ajan solda kalır, yanındaki
  sekme (tek sekmeyse yeni bir terminal) sağda açılır.

Her yarının ince bir başlık satırı, ayrıca kendi başlık şeridi, izin kartı ve mesaj
kutusu vardır. Tek bölmeye dönmek için:

- bir yarının başlık satırındaki **×** o yarıyı kaldırır (sekmesi sekme olarak açık
  kalır);
- sekme menüsündeki **Bölmeyi kapat** sol yarıyı bırakır;
- başlık şeridindeki bölme düğmesi (artık **Bölmeyi kapat**) kendi yarısını kaldırır;
- yarılardan birinin sekmesini kapatmak da diğerini panelde tek başına bırakır.

Bölmek hiçbir terminali kapatmaz ya da çoğaltmaz. Bölme yeniden açılışta hatırlanır;
[Zaman akışı](#zaman-akışı) en son odaklanan yarıyı izler. Dar bir yarıda izin kartı
bölmenin tamamını kaplamak yerine kayar. Başlık şeridindeki bölme düğmesi yalnızca ajan
bölmelerinde vardır; düz kabuk sekmeleri sekme menüsüyle ya da sürükleyerek bölünür.

## Ajanlar

### Ajan durumları

Her ajan şu durumlardan birindedir. Durumlar yalnızca renkle değil, şekil ya da
hareketle de ayrılır; renge bakmadan da ayırt edilebilir:

| Durum | Renk | Anlamı |
|---|---|---|
| Çalışıyor | Amber, dönen | Etkin olarak çalışıyor |
| İzin bekliyor | Kırmızı-turuncu, nabız gibi atan | Bir aracı onaylamanızı ya da reddetmenizi bekliyor |
| Cevap bekliyor | Kırmızı-turuncu, nabız gibi atan | Turunu bitirdi ve size bir şey sordu |
| Bitti | Mavi | Bitirdi; henüz bakmadınız |
| Boşta | Yeşil | Bitirdi ve gördünüz |
| Hata | Kırmızı-turuncu, ⚠ ile | Tur bir hata ya da limitle bitti |

"Cevap bekliyor" ve "Hata" arka plan servisinden gelir; bu yüzden ajanın
entegrasyonu gerekir (aşağıya bakın).

### Ajanlar paneli

**Ajanlar** paneli (sol sütunun altı) algılanan her ajan işlemini durumuyla listeler.
Satırlar önce bekleyenler, sonra bitenler, çalışanlar ve boştakiler olarak sıralanır.
Bir satıra tıklamak o çalışma alanına ve terminal sekmesine geçer (`Bitti` satırını
`Boşta` yapar). Etkin çalışma alanının kökü en acil ajan durumu için küçük bir nokta,
her terminal sekmesi de buna uyan bir nokta gösterir; durum çubuğu her durumun
sayısını gösterir (boştaki ajanlar sayılmaz). `Ctrl+Shift+A` sıradaki bekleyen ajana
geçer (odaktaki panelden sonrakine, başa dönerek).

**Ajanlar nasıl izlenir:**
- Entegrasyonu kurulu bir ajan (bkz. [Desteklenen ajanlar](#desteklenen-ajanlar))
  prompt'ları, izin isteklerini ve bitişleri hook'ları üzerinden bildirir.
- Özel bir ajan Agent Integration Protocol ile bildirir (bkz.
  [Özel ajanlar](#özel-ajanlar)).
- İkisi de yoksa ajan, işlem adından (tanımındaki **Çalıştırılabilir dosya adları**)
  ve basit bir "çıktı varsa çalışıyor, ~3 sn sessizlik boşta" kuralıyla tanınır; o
  zaman yalnızca `Çalışıyor`/`Boşta` gösterir, tanımındaki bir ekran kuralı terminal
  ekranında bir soruyu tanımadıkça.

**Ajan başlatma:** Terminal panelindeki **Yeni ajan ▶** ve paletteki **Ajanlar: Yeni …**
kurulu her ajanı (programı `PATH`'te bulunan), ardından **Ayarlar → Ajanlar → Ajan
komutları**'ndaki, hiçbir ajanın karşılamadığı komutları listeler.

### Ajan başlığı ve çerçeve

Bir terminal sekmesinde ajan çalışırken terminalin üstünde bir başlık şeridi çıkar:
ajan ve proje, dal ve model, durum ve ne kadar sürdüğü, context penceresinin
doluluğu, oturumun token'ları (model fiyatı biliniyorsa tahmini maliyeti) ve ajanın en
çok dolmuş plan limiti. Tire, ajanın o değeri bildirmediği anlamına gelir. Terminal
renkli bir çerçeve de alır: çalışırken ince amber bir kenar, sizi beklerken daha
belirgin kırmızı-turuncu bir kenar ve parıltı. Başlık yalnızca bilgi gösterir;
terminalden odağı asla almaz.

### İzin kartı

Bir ajan izin istediğinde ve arka plan servisi isteği biliyorsa, o ajanın terminalinin
alt kısmında bir kart çıkar. Kart ajanın ne yapmak istediğini (komut, dosya ya da
araç), ne kadar süredir beklediğini ve istek riskli görünüyorsa bir risk etiketini
(dosya siliyor, veritabanına yazıyor, ağ erişimi, paket kuruyor, uzak depoya
gönderiyor) gösterir.

| Düğme | Gönderilen | Etkisi |
|---|---|---|
| **Bir kez izin ver** | ajanın kendi tuşu, örn. `1` (Claude Code), `y` (Codex) | Yalnızca bu isteğe izin verir |
| **Bu projede hep izin ver** | örn. `2` (Claude Code), `p` (Codex); yalnızca ajanın sabit bir tuşu varsa | Ajanın kendi "hep izin ver" seçeneği |
| **Reddet** | örn. `Esc`, `n` (Cursor CLI) | Reddeder; ajana bunun yerine ne yapması gerektiğini söyleyin |
| **Terminalde cevapla** | hiçbir şey | Kartı bu istek için gizler ve terminale odaklanır |

Tuşlar her ajanın tanımından gelir; [Desteklenen ajanlar](#desteklenen-ajanlar)
tablosu bunları listeler. Cursor CLI'da kart, sorusu terminal ekranında tanındığında
komut ayrıntısı olmadan çıkar.

Düğmeler ajanın kendi tuşlarına onun terminalinde basar; sonuç, ajanın sorusunu
kendiniz cevaplamakla tamamen aynıdır. Terminalin altındaki kısa bir not hangi tuşun
gönderildiğini doğrular. Odak kartın içindeyken `Enter` bir kez izin verir, `Esc`
reddeder; bunun dışında `Esc` terminalindir. Odak yalnızca kart görünür ve odaktaki
pencerede açıldığında **Bir kez izin ver**'e geçer. Tuşları doğrulanmamış ajanlarda
yalnızca **Terminalde cevapla** sunulur.

### Mesaj kutusu

Her ajan terminalinin altında bir mesaj kutusu (composer) vardır. Terminale her zaman
doğrudan da yazabilirsiniz; mesaj kutusu uzun mesajlar, dosyalar, görseller, dikte ve
tekrar kullandığınız istemler içindir. Odağı kendiliğinden asla almaz ve terminale ait
tuşları yakalamaz.

- `Enter` gönderir, `Shift+Enter` yeni satır açar, `Esc` odağı terminale geri verir.
- **Dosyalar:** `@` ve bir dosya adının bir kısmını yazınca çalışma alanından öneriler
  gelir; `↑`/`↓` seçer, `Enter` ya da `Tab` çalışma alanına göre yolu ekler, `Esc`
  listeyi kapatır.
- **Görseller:** bir görsel yapıştırın (`Ctrl+V`, örneğin `Win+Shift+S`'den sonra).
  Çalışma alanındaki `.kotilo/attachments/` klasörüne PNG olarak kaydedilir (klasör
  gerekince oluşturulur), bir etiket olarak görünür ve mesajın sonuna `@<yol>` olarak
  eklenir. İlk seferde bir ipucu, görsellerin commit'lenmemesi için `.kotilo/`
  satırını `.gitignore`'a eklemenizi önerir; Kotilo `.gitignore`'u kendisi asla
  düzenlemez.
- **Mikrofon:** mesaja dikte etmek için mikrofona tıklayın, bitirmek için yeniden
  tıklayın; metin imlecin olduğu yere gelir, göndermeden önce düzenleyebilirsiniz.
  [Dikte](#dikte)'nin konuşma modelini ve ayarlarını kullanır, genel dikte kısayolu
  kapalıyken de çalışır. Hiçbir şey Windows ya da pano üzerinden yapıştırılmaz.
- **Kayıtlı istemler:** yer imi düğmesi kayıtlı istemlerinizi açar. **Mesajı istem
  olarak kaydet** o anki metni saklar (ilk satırı başlık olur); bir isteme tıklayınca
  imlecin olduğu yere eklenir, listeyi süzebilir ya da **×** ile silebilirsiniz.
  Kayıtlı istemler sizin metninizdir ve uygulamanın `settings.json` dosyasında durur
  (bkz. [Veri konumları](#veri-konumları)); Kotilo'ın sakladığı tek istem metni
  budur, o da yalnızca siz kaydettiğiniz için. Tanılama zip'lerinde yalnızca sayıları
  bulunur.

**Gönderme nasıl çalışır:** mesaj ajanın terminaline tek bir yapıştırma olarak gider,
kısa bir an sonra da `Enter` gelir; tıpkı yapıştırıp `Enter`'a basmışsınız gibi.
"Bracketed paste" anlayan ajanlar (Claude Code, Codex ve diğer tam ekran TUI'ler) çok
satırlı bir mesajı tek parça alır; anlamayan bir programda çok satırlı mesaj önce
bilinen yapıştırma uyarısını gösterir (bkz. [Terminaller](#terminaller)).

### Ajan entegrasyonları

**Ayarlar → Ajanlar → Ajan entegrasyonları**'nı açın. Her ajanın bir kartı vardır:
avatarı, programının `PATH`'te olup olmadığı, durumu (kurulu değil, kurulu ve güncel,
güncelleme gerekiyor, ayar dosyası okunamıyor), ayar dosyasının yolu ve **Kur** /
**Onar** / **Kaldır** düğmeleri. Claude Code entegrasyonu ayrıca Ajanlar panelinin
**⋯** menüsünden, o panelin üstündeki uyarı şeridinden ve komut paletinden
kurulabilir. **Tanımları yeniden yükle**, bir özel ajanın dosyasını elle
düzenledikten sonra tüm ajan tanımlarını yeniden okur.

Kart, kurulu hook'ların neden sessiz kalabileceğini de söyleyebilir:
- *Ajan yeni hook'ları ancak siz onayladıktan sonra çalıştırır* (Codex): ajanı açıp
  Kotilo hook'larını onaylayın (Codex'te `/hooks` ekranında). Kotilo bunları
  sizin yerinize asla onaylamaz.
- *Hook'lar yalnızca Gemini'de güvendiğiniz klasörlerde çalışır*: Gemini CLI, kullanıcı
  düzeyindekiler dahil hook'ları yalnızca güvenilen klasörlerde çalıştırır.
- *Hook'lar ajanın kendi ayarlarında kapalı*: ajanın kendi anahtarı tüm hook'ları
  kapatıyor (Gemini `hooksConfig.enabled`, Qwen `disableAllHooks`, Droid
  `hooksDisabled`).

Her kayıt `%LOCALAPPDATA%\kotilo\hub\bin\kotilo-hook.exe` dosyasını çağırır. Her
ajan için kurulum:
- Bir şey yazmadan önce zaman damgalı bir yedek alır (`<dosya>.kotilo-backup-<zaman>`,
  asıl dosyanın yanında); yedeğin yolu kurulumdan sonra gösterilir.
- Dosyadaki diğer her şeyi korur: kendi ayarlarınızı, başka araçların aynı olaylar
  için eklediği hook'ları, ilgisiz anahtarları.
- Tekrar çalıştırılabilir: yeniden kurmak (ya da yeni bir Kotilo sürümünden sonra
  **Güncelle**) yalnızca Kotilo'ın kendi kayıtlarını değiştirir; **Kaldır** yalnızca
  Kotilo'ın kayıtlarını siler, gerisine dokunmaz.
- Okuyamadığı bir dosyaya dokunmayı reddeder (ve bunu bildirir); anlamadığı bir
  dosyayı asla yeniden yazmaz.

Hook yardımcısı her zaman sessizce çıkar ve hiçbir şey yazdırmaz; bu yüzden bir ajanı
bozamaz. Arka plan servisine bildirir; Kotilo dışında başlatılan oturumlar da
görünür (Görev kontrol bunları **Kotilo dışında çalışıyor** diye işaretler). Prompt
ve yanıt metni gönderilmeden önce silinir; yalnızca uzunluğu kalır.

### Desteklenen ajanlar

| Ajan | Entegrasyonun yazdığı yer | İzin kartı tuşları | Kullanım | Sınırlar |
|---|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | `1` · `2` (hep) · `Esc` | Konuşma kayıtlarından (plan limitleri henüz gösterilmiyor) | — |
| Codex CLI | `~/.codex/hooks.json` | `y` · `p` (hep, sunulduğunda) · `Esc` | Oturum dosyalarından, plan limitleriyle | Hook'ları `/hooks`'ta onaylayın; "cevap bekliyor" sinyali yok |
| GitHub Copilot CLI | `~/.copilot/hooks/agenthub.json` (kendi dosyası) | `1` · `Esc` | Yalnızca düzgün bir `/exit`'ten sonra; maliyet yok (Copilot premium istek faturalar) | Plan limiti yok |
| Gemini CLI | `~/.gemini/settings.json` | `1` · `Esc` | Sohbet kayıtlarından | Hook'lar yalnızca güvenilen klasörlerde çalışır; bir retten sonra kart sonraki prompt'a kadar kalır |
| Qwen Code | `~/.qwen/settings.json` | `1` · `2` (hep) · `Esc` | Sohbet kayıtlarından | — |
| Factory Droid | `~/.factory/hooks.json` (ya da `settings.json`'daki `hooks`) | henüz yok — terminalde cevaplayın | Oturum ayarlarından | Değişiklik bir sonraki oturumda geçerli olur |
| OpenCode (v2) | `~/.config/opencode/plugins/` içinde bir eklenti | `Enter` · `Esc` | Veritabanından | Henüz bir terminal sekmesine bağlanmıyor; kurulumdan sonra OpenCode'u yeniden başlatın |
| Cursor CLI | `~/.cursor/hooks.json` | `y` · `n` | Veri yok | İzin soruları ekranda tanınır, ayrıntısız |

Gemini CLI, Qwen Code, Factory Droid ve Cursor CLI belgelerine göre yapıldı ve henüz
gerçek bir kurulumda denenmedi. Bir ajan tuşlarını değiştirdiyse **Terminalde
cevapla**'yı kullanın.

### Özel ajanlar

Başka herhangi bir ajan CLI'ı kod yazmadan eklenebilir. **Ayarlar → Ajanlar**'da
**Özel ajan ekle**'yi seçin; sihirbaz şunları sorar:

1. **Ad**: bir kimlik (küçük harf, rakam ve `-`; yerleşik bir ajanın kimliği olamaz),
   görünen ad, avatar harfi ve rengi.
2. **Başlatma**: **Yeni ajan**'ın çalıştırdığı komut, argümanları ve ajanı terminalde
   tanıyan, kurulu olup olmadığını söyleyen çalıştırılabilir dosya adları.
3. **İzin tuşları** (isteğe bağlı): kartın **Bir kez izin ver**, **Her zaman izin ver**
   ve **Reddet** için gönderdiği tuşlar. Tuş yazımı: bir karakter (`y`, `1`), adlı bir
   tuş (`Enter`, `Esc`, `Tab`, `Space`, `Up`, `Down`, `Left`, `Right`),
   `Ctrl+<harf>` ya da boşlukla ayrılmış birkaçı (`Down Enter`). Tuş yoksa kart
   yalnızca **Terminalde cevapla**'yı sunar.
4. **Ekran kuralları** (isteğe bağlı): ajan ekranının son satırları üzerindeki bir
   düzenli ifade, eşleştiği sürece bir durum belirler — *izin bekliyor*, *cevap
   bekliyor*, *çalışıyor* ya da *bitti* — ajanın kendisinin bildirmediği sorular için.
   Yeni çıktı gelince ya da siz yazınca bitebilir. Lookaround ve geri başvuru
   desteklenmez.
5. **Bağlantı**: ajanın (ya da bir sarmalayıcı betiğin) durumunu bildirmek için
   çalıştırdığı komutlar.

Tanım `%APPDATA%\kotilo\adapters\<id>\adapter.json` olarak kaydedilir; kartındaki
**Düzenle** ve **Sil** onu değiştirir ya da kaldırır. Hatalı bir tanım (örneğin elle
düzenlenmiş bir dosya) hatasıyla listelenir ve düzeltilene kadar yok sayılır.

**Agent Integration Protocol.** Özel bir ajan, Kotilo ile gelen hook aracıyla
(`%LOCALAPPDATA%\kotilo\hub\bin\kotilo-hook.exe`) bildirir:

```
kotilo-hook --agent <id> --event <olay> [--session <id>] [--json <payload>]
```

| Olay | Anlamı |
|---|---|
| `session-start` | Bir oturum başladı (payload'daki `cwd` projeyi belirler) |
| `working` | Ajan bir tur üzerinde çalışıyor |
| `waiting-permission` | İzin gerekiyor (`tool`, `command` ya da `path`; izin kartı bunları gösterir) |
| `waiting-input` | Cevabınızı bekliyor |
| `done` | Tur bitti |
| `error` | Tur başarısız oldu (`kind`: `usageLimit`, `rateLimit`, `overloaded`, `auth`, `api`) |
| `session-end` | Oturum bitti |
| `usage` | Token sayıları (`model`, `inputTokens`, `outputTokens`, isteğe bağlı `cachedTokens`, `costUsd`) |

Bir Kotilo terminalinin içinde araç olayları o sekmeye bağlar. Hiçbir şey
yazdırmaz ve her zaman başarılı çıkar, bu yüzden ajanı bozamaz; arka plan servisi
kapalıysa olayı saklar ve sonra teslim eder. Prompt, cevap ve soru metni asla
saklanmaz. Bir program aynı olayları doğrudan arka plan servisine de gönderebilir
(veri klasöründeki `port.json`'daki port ve token ile `POST /v1/events`; ikisi de her
açılışta değişir).

### Bildirimler

Arka plan servisi çalışırken ne zaman bildirim gösterileceğine o karar verir;
**Ayarlar → Bildirimler**'deki kuralları (izin gerektiğinde, cevabınız beklendiğinde,
iş bittiğinde, ajan sessiz kaldığında, hatırlatmalar, hatalar ve limitler, tamamlanan
todo maddeleri, context dolmak üzereyken), sessiz saatleri ve **Rahatsız etme**'yi
kullanır. Uygulama Windows bildirimini gösterir ve görev çubuğu simgesini yakıp
söndürür. O ajanın terminali odaktaki pencerede görünüyorsa bildirim gösterilmez.
**Ayarlar → Ajanlar → Bildirimler** tüm ajan bildirimlerini kapatır.

Arka plan servisi çalışmıyorsa uygulama kendi kuralına döner: pencere odakta değilken
bir ajan `İzin bekliyor` ya da `Bitti` durumuna geçince bildirim gösterir. Bildirime
tıklamak panele götürmez (Windows bildirimleri burada bunu desteklemiyor); bunun
yerine `Ctrl+Shift+A`'yı kullanın.

## Zaman akışı

Çalışma alanı ekranının sağ kenarındaki Zaman akışı şeridi, odaktaki terminaldeki
ajanın ne yaptığını gösterir. Etkin sekmeyi izler ([bölünmüşken](#yan-yana-iki-bölme)
en son odaklanan yarıyı); o sekmede ajan oturumu yoksa çalışma alanı klasörünün en son
etkin oturumunu gösterir. Üstündeki ok düğmesiyle ya da komut paletindeki **Görünüm:
Zaman Akışını Aç/Kapat** ile gizleyip gösterin (henüz klavye kısayolu yok); sol
kenarını sürükleyerek genişliğini değiştirin. Görünürlük ve genişlik hatırlanır.

- **Plan:** ajanın güncel yapılacaklar listesi ve ilerlemesi (örneğin `3 / 5`);
  Claude Code'un TodoWrite aracıyla tuttuğu liste.
- **Etkinlik:** ajanın araç çağrıları, en yenisi üstte: türüne göre bir harf simgesi
  (okuma, düzenleme, yazma, komut, arama, alt görev), dosya (projeye göre yol) ya da
  komut, çalışıyor / bitti / başarısız / reddedildi durumu ve süresi. **Yeni istem**
  çizgisi her prompt'unuzun başladığı yeri gösterir.
- **Değişen dosyalar:** çalışma alanının `HEAD`'e göre commit edilmemiş git
  değişiklikleri (değişti, eklendi, silindi, yeniden adlandırıldı, izlenmiyor) ve
  `+eklenen −silinen` satır sayıları. Ajanın düzenlediği ya da yazdığı dosyalar önce
  gelir; başka yolla, ajanın kabuk komutlarıyla da yapılan değişiklikler **Diğer
  değişiklikler** altındadır. Liste diskteki dosya değişikliklerinden sonra ve yenile
  düğmesiyle tazelenir; uygulama dışında yapılan bir commit ya da checkout bir sonraki
  dosya değişikliğinde ya da elle yenileyince görünür.

Değişen bir dosyaya tıklamak görüntüleyicide bir **fark sekmesi** açar,
`<ad> (fark)`: solda `HEAD`, sağda çalışma kopyanız, salt okunur. İkili dosyalarda ve
2 MB'tan büyük `HEAD` sürümlerinde fark yerine bir not çıkar. Fark sekmeleri yeniden
açılışta geri gelmez.

Etkinlik ve plan ajanın hook'larından gelir ve yalnızca arka plan servisinin
belleğinde yaşar: oturum başına son 200 araç çağrısı tutulur, oturum bittikten 10
dakika sonra silinir ve arka plan servisi yeniden başlarsa kaybolur. Dosya içerikleri
ve araç çıktıları bunun parçası değildir. Araçları yalnızca bittikten sonra bildiren
ajanlar (Copilot CLI, Cursor CLI) yalnızca bitmiş kayıtlar gösterir. Değişen dosyalar
çalışma alanında salt okunur `git` çalıştırılarak bulunur; bu yüzden `git`'in `PATH`'te
olması gerekir.

## Genel bakış

Genel bakış ekranı sayıları bir bakışta gösterir: bir özet satırı (oturumlar, kaçı
sizi bekliyor, kaçı çalışıyor), kalan süresi, harcama hızı ve tahminiyle etkin 5
saatlik blok, bugün ve bu hafta, plan limitleri, **Görev kontrolü aç** düğmeli bir
oturum özeti (oturum kutucukları [Görev kontrol](#görev-kontrol)'de durur) ve todo
dosyalarından proje ilerlemesi.

Maliyetler fiyat tablosundan (Ayarlar → Kullanım ve maliyet) yapılan yerel
tahminlerdir, resmî rakamlar değildir. Limitler ajanın kendi son bildirimidir ve yerel
tahmin olarak gösterilir.

## Görev kontrol

Görev kontrol (`Alt+3`) canlı her ajan oturumunu bir kutucuk olarak gösterir; böylece
birkaç ajanı aynı anda izleyebilirsiniz. Başlık ajanları ve kaçının sizi beklediğini,
çalıştığını ya da bittiğini sayar; yanındaki süzgeç **Tümü**, **Sizi bekliyor** (izin
ya da cevabınızı bekleyen veya hatayla biten), **Çalışıyor** ya da **Bitti** (bitmiş,
boşta) gösterir. Arka plan servisinin bayat saydığı oturumlar yalnızca **Tümü**
altında görünür. Plan limitleri şeridi Genel bakış'takiyle aynıdır.

Her kutucuk projeyi, ajanı ve çalışma alanını (ya da modeli), durumu ve ne kadar
sürdüğünü, bir de önizleme gösterir: o ajanın terminalinin boş olmayan son beş satırı;
Görev kontrol açıkken ve pencere görünürken yaklaşık saniyede bir tazelenir. Önizleme
ekrandaki terminalden okunur; asla günlüğe yazılmaz ya da saklanmaz. Alt satır ne
kadar süredir beklediğini (ya da context kullanımını veya çalışan aracı), etkin alt
ajanları ve maliyeti (model fiyatı yoksa token'ları) gösterir. Sizi bekleyen
kutucukların çerçevesi belirgindir.

Bir kutucuğa tıklamak o ajanın çalışma alanına ve terminal sekmesine geçer. Kotilo
dışında başlatılan oturumlar **Kotilo dışında çalışıyor** diye işaretlenir;
önizlemeleri yoktur ve açılamazlar; kutucukları bunun yerine arka plan servisinin
bildiklerini gösterir (bekleyen bir izin, ajanın son bildirimi ya da çalışan aracı).

## Kullanım

Son 30 günün günlük kullanımı token ya da maliyet olarak, ajana göre süzülebilir; son
7 günün 5 saatlik blokları; ve son 30 günün projeye, modele ya da ajana göre dağılımı.
Fiyatı olmayan bir model (örneğin Codex modelleri) "—" gösterir; maliyetini tahmin
etmek için onu `pricing.json`'a ekleyin.

## Raporlar

- **Günlük özet**: günün rakamlarıyla (etkin süre, oturumlar, token, maliyet, bekleme)
  saklanan günlük özetler. Yeni özet üretimi sonraki bir güncellemede yapay zekâ
  sağlayıcısıyla gelecek.
- **Beklemeler**: son 7 günde ajanları ne kadar beklettiğiniz: toplamlar, ortalama ve
  ortanca, izin ve cevap beklemeleri, günün saatine ve projeye göre, en uzun
  beklemeler.
- **Maliyet**: müşteriye, projeye, ajana ya da modele göre gruplanan bir tarih
  aralığı; **CSV'ye aktar** ve **Excel'e aktar** düğmeleriyle. Müşteri etiketleri
  Projeler ekranında verilir.

## Projeler

Projeler ajan etkinliğinden bulunur; **Proje klasörü ekle…** henüz etkinliği olmayan
bir klasörü izlemeye alır. Her proje todo ilerlemesini (Ayarlar → Projeler'deki todo
dosyası desenine uyan dosyalardan), sıradaki açık maddeyi, son etkinliği ve git
durumunu (dal, değişen dosyalar, ileride/geride) gösterir. Bir proje seçince todo
dosyaları listelenir; **Aç** dosyayı görüntüleyicide açar, açık bir maddeye tıklamak
onu kendi satırında açar (ikisi de yalnızca proje çalışma alanlarınızdan biriyse).
**Proje ayrıntıları** altında görünen ad, müşteri (maliyet raporlarında kullanılır)
verebilir ve projeyi gizleyebilirsiniz.

## Görevler

Proje todo dosyalarından ayrı, kişisel notlar ve yapılacaklar. **Hızlı ekle**'ye yazıp
Enter'a basın; ilk satır başlık, gerisi ayrıntıdır. Görevlerin bitiş tarihi ve saati,
önceliği ve projesi olabilir. Açık, tamamlanan ya da tümüne göre süzün; metinde ya da
projede arayın. Gecikmiş ve bugünkü görevler işaretlenir.

## Dikte

Dikte, konuşmayı bu bilgisayarda metne çevirir; ses hiçbir zaman saklanmaz.

**Canlı dikte.** İmleci metnin gideceği yere koyun (bir editör, sohbet kutusu ya da
terminal; bu uygulamada veya başka bir uygulamada) ve kısayolu kullanın, varsayılan
`Ctrl+Alt+D`:

- Konuşurken kısayolu **basılı tutun**; bırakınca biter.
- Başlatmak için **bir kez basın**; bitirmek için yine basın.
- `Esc` ya da ekrandaki ✕ iptal eder.

Ekranın altındaki küçük pencere ses seviyesini, süreyi ve aşamayı (dinleniyor, yazıya
dökülüyor, yapay zekâ düzeltmesi, sonuç) gösterir. Odağı hiç almaz; metin, başladığınız
pencereye gider. Kayıt, Ayarlar → Dikte'deki en uzun süre dolunca (varsayılan 5 dakika)
kendiliğinden durur.

Metin, Ayarlar → Dikte'deki seçime göre yapıştırılır (pano sonra eski haline döner) ya da
yazılır; terminallerde Shift+Insert kullanılır. Yönetici olarak çalışan bir pencere bu
uygulamadan girdi alamaz; o zaman metin panoda bırakılır ve pencere bunu söyler.
`Ctrl+Alt+Shift+D` son dikteyi yeniden yapıştırır. İsteğe bağlı çıktılar: pano ve bir
Markdown dosyası. Türkçe ve İngilizce tanınır (ya da otomatik); kelime listesindeki
sözcükler orada yazıldığı gibi yazılır.

İlk dikte için bir konuşma modeli gerekir: bu ekrandan indirin (Large daha isabetlidir ve
ekran kartıyla hızlıdır; Small daha hafiftir). Ekran kısayolu da gösterir, başka bir
program kullanıyorsa uyarır ve dikte geçmişini tutar (kopyalama, silme, temizleme;
kapatılabilir).

## Yapay zekâ sağlayıcıları

Kotilo'ın kendi yapay zekâ işleri – **asistan**, **günlük özet** ve **dikte
düzenleme** – Ayarlar → Yapay zekâ'da seçtiğiniz sağlayıcıda çalışır. Her özelliğin kendi
sağlayıcısı ve isteğe bağlı bir modeli vardır; model boş kalırsa sağlayıcının varsayılanı
kullanılır.

- **Ajan CLI'ları.** Kurulu ajanlarınız (Claude Code, Codex, Copilot, OpenCode, …) kendi
  oturumunuzla, araçlar kapalı olarak arka planda çalışır. Bu çalıştırmalar kendi
  aboneliğinizi ya da kotanızı kullanır ve oturum olarak görünmez. **Doğrulanmadı**
  işaretli ajanların arka plan komutu belgelerinden alınmıştır; kurulu sürümle henüz
  denenmemiştir. OpenCode için yapılandırılmış bir sağlayıcı gerekir: ücretsiz "Console" katmanı
  OpenCode uygulamasının dışından gelen çalıştırmaları reddeder.
- **OpenAI uyumlu uç noktalar.** OpenAI sohbet API'sini konuşan her sunucu: **Ollama**
  (`http://127.0.0.1:11434/v1`), **LM Studio** (`http://127.0.0.1:1234/v1`) ya da
  **llama.cpp** (`http://127.0.0.1:8080/v1`) üzerinden yerel bir model veya barındırılan bir
  API. **Uç nokta ekle…** bir ad, temel URL (hazır ayarlar yalnızca URL'yi doldurur),
  varsayılan model (uç nokta kaydedilince **Modelleri getir** sunucudaki modelleri
  listeler) ve isteğe bağlı bir API anahtarı ister. Uç noktalar hemen kaydedilir; bu
  bilgisayardakiler **Yerel** rozeti alır.

**Anahtarlar** doğrudan Windows Kimlik Bilgileri Yöneticisi'ne gider. Ayar dosyasına ya da
günlüklere asla yazılmaz; uygulama yalnızca **Anahtar kayıtlı** gösterir. **Anahtarı
kaldır** onu siler; bir uç noktayı silmek anahtarını da siler ve onu kullanan özellikler
bir ajan CLI'ına geçer.

**Dene**, sabit bir "Reply with OK" istemi gönderir ve süreyi ya da neden başarısız
olduğunu (kurulu değil, oturum açılmamış, ulaşılamıyor, anahtar reddedildi, zaman aşımı,
…) gösterir. Yanıtın kendisi hiç gösterilmez ve saklanmaz; bir ajan CLI'ını denemek kendi
kotanızı kullanır.

**Tamamen yerel** rozeti, açık olan her yapay zekâ özelliği bu bilgisayardaki
(`localhost`) bir uç noktayı kullandığında görünür; hiçbir şey dışarı çıkmaz. Konuşma
tanıma (Whisper) her zaman yerelde çalışır. İstemler ve yanıtlar asla günlüğe yazılmaz ya
da saklanmaz; günlüğe yalnızca sağlayıcı, süre ve sonuç düşer.

## Asistan

Asistan, gün içinde aklınıza takılan kısa sorular için küçük bir sohbet penceresidir ("son
commit'i nasıl geri alırım?", "bu regex ne yapıyor?"). Genel amaçlı bir sohbettir:
oturumlarınızı, dosyalarınızı, terminallerinizi ya da kullanımınızı görmez; yapay zekâ
araçlar kapalıyken çalışır.

Açmak için **Ayarlar → Yapay zekâ** bölümündeki **Asistan** satırında **Asistanı kullan**
kutusunu işaretleyin, bir **Kısayol** seçin (varsayılan `Ctrl+Alt+Space`) ve kaydedin.
Kısayol her uygulamadan çalışır ve pencereyi açıp kapatır. Aynı satırdaki **Asistanı aç**
düğmesi ve maskotun sağ tık menüsündeki **Asistanı aç** da pencereyi açar. Kısayolu başka bir
uygulama kullanıyorsa alanın altında bunu söyleyen bir uyarı çıkar; o zaman başka bir kısayol
seçin. Dikte ve görev kısayollarıyla da aynı olamaz. Sağlayıcı ve model de aynı satırdan
seçilir.

Penceredeki tuşlar:

| Tuş | Ne yapar |
|---|---|
| `Enter` | Gönderir |
| `Shift+Enter` | Yeni satıra geçer |
| `↑` (mesaj kutusu boşken) | Son soruyu düzenlemenizi sağlar: soru ve yanıtı silinir, metin kutuya geri gelir |
| `Esc` | Yazılmakta olan yanıtı durdurur; yanıt yoksa pencereyi kapatır |
| `Ctrl+N` | Yeni sohbet başlatır |

Yanıtlar yazıldıkça akar; Markdown, tablo ve renklendirilmiş kod desteklenir. Kod
bloklarının ve yanıtların kendi kopyalama düğmesi vardır. Yanıt sürerken **Durdur** onu
keser, o ana kadar yazılanı bırakır. Bir sorun çıkarsa (ajan CLI'ı kurulu değil ya da
oturum açılmamış, sunucuya ulaşılamıyor, süre doldu…) hata o sorunun altında görünür;
çözümü ayarlardaysa yanında **Ayarlar → Yapay zekâ** düğmesi de olur.

**Hiçbir şey kaydedilmez.** Pencere her açıldığında yeni bir sohbet başlar; sohbet yalnızca
pencere açıkken vardır, kapanınca kaybolur. Kotilo ne mesajları ne yanıtları ne de bir
başlığı veritabanına, ayarlara ya da günlüğe yazar (günlüğe yalnızca sağlayıcı, süre, sonuç
ve karakter sayıları düşer). Her soruda o ana kadarki sohbet, seçtiğiniz sağlayıcıya
gönderilir; pencerenin altındaki satır da bunu hatırlatır ("Hiçbir şey kaydedilmez · araçlar
kapalı · … sağlayıcısına gider").

**Ajan CLI'ları kendi kopyalarını tutabilir.** Asistan bir ajan CLI'ı üzerinden çalışıyorsa o
CLI sohbeti kendi oturum dosyalarına yazabilir; bu, Kotilo'nun elinde değildir. Kotilo
destekleyen CLI'ları (Claude Code, Codex, Qwen Code) oturum dosyası bırakmadan başlatır;
OpenAI uyumlu uç noktalar da bu bilgisayarda bir şey bırakmaz. Diğerlerinde pencerenin
altında bir uyarı görünür: GitHub Copilot CLI, OpenCode ve Gemini CLI için "… bu sohbetin
bir kopyasını kendi oturum dosyalarında saklar", durumun bilinmediği Cursor ve Factory Droid
için "… saklayabilir". Bu sizin için önemliyse asistana başka bir sağlayıcı seçin.

## Maskot

Kotilo'nun robot salyangozu masaüstünde durup ajanlarınızın genel durumunu gösterebilir;
böylece uygulamayı açmadan bir ajanın sizi bekleyip beklemediğini görürsünüz. Varsayılan
olarak kapalıdır: **Ayarlar → Maskot** bölümünden ("Robot salyangozu masaüstünde göster")
ya da bir ajan ilk kez çalışmaya başladığında çıkan tek seferlik öneride **Aç** ile açılır.

Salyangozun çekirdeği ve antenleri, Kotilo dışında başlatılan oturumlar dahil tüm ajanlar
arasındaki en acil durumun rengini alır:

| Salyangoz | Anlamı |
|---|---|
| Kırmızı çekirdek, atan bir hale ve "!" | Bir ajan izninizi bekliyor |
| Kırmızı çekirdek ve "!" (halesiz) | Bir ajan hatayla durdu |
| Kırmızı çekirdek ve "?" | Bir ajan cevabınızı bekliyor |
| Kehribar, ter damlalarıyla | Ajanlar çalışıyor ve bu 5 saatlik bloğun kullanım eşiğinizi aşacağı öngörülüyor |
| Kehribar, yürüyor | Ajanlar çalışıyor |
| Mavi, kısa bir zıplama | Bir ajan uzun bir turu bitirdi (yalnızca "Biten işi kutlasın" açıksa) |
| Soluk, "Zz" | Çalışan bir şey yok ya da rahatsız etme / sessiz saatler açık |

Salyangoza **tıklayınca** Kotilo öne gelir: bekleyen bir izin, cevap ya da hata varsa en
uzun süredir bekleyen ajan açılır; terlerken Kullanım sayfası açılır. **Sağ tıkla** **1 saat
gizle**, **Maskotu kapat**, **Maskot ayarları…** ve asistan açıksa **Asistanı aç** seçenekleri
gelir. Görev çubuğu boyunca
**sürükleyerek** yerini değiştirebilirsiniz; yeri hatırlanır.

Ayarlar: **Boyut** (Küçük, Orta, Büyük), **Yerleşim** ("Görev çubuğunda yürüsün" ya da sağ
altta "Köşede otursun") ve **Biten işi kutlasın**. Gizliyken bölümde "… saatine kadar gizli"
yazısı ve **Şimdi göster** düğmesi görünür.

Salyangoz yalnızca ajanlar çalışırken yürür, diğer zamanlarda işlemci kullanmadan durur.
Birincil monitörde kalır, tam ekran bir uygulama, oyun ya da sunum açıkken gizlenir ve
Windows animasyon efektleri kapalıysa (Ayarlar → Erişilebilirlik → Görsel efektler) yürümez.

## Komut paleti ve hızlı açma

- `Ctrl+Shift+P` (ya da hızlı açma kutusunda ilk karakter olarak `>`) **komut
  paletini** açar: kayıtlı her komutta bulanık arama yapar; komutlar "Kategori:
  Başlık" olarak gruplanır ve sağda kısayolu gösterilir. Boş sorgu en son
  kullandığınız komutları önce gösterir.
- `Ctrl+P` **hızlı açmayı** açar (etkin çalışma alanında bulanık dosya araması). Boş
  sorgu etkin çalışma alanının açık sekmelerini, en son kullanılan önce olmak üzere
  listeler. `Enter` vurgulanan dosyayı önizleme sekmesinde açar (çift tıklama gibi);
  `Ctrl+Enter` sabit sekmede açar. Arama iç dizin sınırına takılırsa sonuçların eksik
  olabileceğini söyleyen bir uyarı çıkar.
- İkisi aynı pencereyi paylaşır: dosya kipindeyken `>` yazmak komut kipine geçirir,
  komut kipinde baştaki `>`'yi silmek dosya kipine döndürür.
- **Terminal odaktayken `Ctrl+P` farklı davranır**; kesin kurallar için bkz.
  [Kısayollar](keybindings.md).
- Paletin **Git** kategorisi her ekranı açar; **Yardım** kategorisi bu kılavuzu,
  Kısayollar'ı, Sorun giderme'yi ya da Hakkında'yı açar (**F1** ile aynı içerik).

## Durum çubuğu

Soldan sağa: etkin çalışma alanının adı, git dalı (detached HEAD durumundaysa 7
karakterlik kısa SHA; git deposu değilse hiçbir şey) ve sağda, etkin belgenin
kodlaması/satır sonu (bir metin dosyası açıkken), durum başına ajan sayıları (hiç ajan
yoksa tamamen gizlenir) ve **?** yardım düğmesi. Git dalı çalışma alanı
değiştirdiğinizde, pencere odağa geldiğinde ve pencere odaktayken 5 saniyede bir
yenilenir (odak dışındayken yoklama durur).

## Ayarlar

`Ctrl+,`, `Alt+9`, gezinme şeridinin altındaki dişli ya da komut paletiyle açılır.
Bölüm listesi soldadır.

**Uygulama bölümleri — değişiklikler hemen uygulanır:**

| Bölüm | Ayarlar |
|---|---|
| Görünüm | Tema (Koyu, Açık, Sistem), Dil (Windows ile aynı, English, Türkçe) |
| Editör | Monaco için editör yazı tipi ailesi ve boyutu (8–32) |
| Terminal | Terminal yazı tipi ailesi (varsayılan Geist Mono) ve boyutu (8–32), açık tüm terminallere anında uygulanır; varsayılan kabuk ("Otomatik" sırasıyla pwsh → Windows PowerShell → cmd → Git Bash → WSL seçer); seçince kopyala; çok satırlı yapıştırmadan önce uyar |
| Dosyalar | Gizlenen desenler (yalnızca ada bakan glob'lar; `/`, `\` içeren ya da `!` ile başlayan desen reddedilir), .gitignore'a uy, panodaki görsel kaydedilince yolu kopyala |
| Ajanlar | "Yeni ajan ▶" için ajan komutları, ajan bildirimlerini aç/kapat, [Ajan entegrasyonları](#ajan-entegrasyonları), [özel ajanlar](#özel-ajanlar) |
| Hakkında ve tanılama | Sürüm ve derleme, lisans (Apache-2.0), proje bağlantıları (kaynak kod, sorunlar, tartışmalar – derlemede bir depo varsa), iletişim, **Güncellemeleri denetle**, **Açılışta güncellemeleri denetle** (varsayılan açık: açılıştan birkaç saniye sonra bir kez denetler; bulunan güncelleme **Yükle ve yeniden başlat** / **Sonra** seçenekli bir bildirim gösterir), aranabilir açık kaynak lisansları listesi, **Tanılama topla**, **Sürüm bilgisini kopyala**, **Yardımı aç**, **Ayrıntılı günlük** (günlük düzeyini `info`'dan `debug`'a çevirir; ara sıra olan bir sorunu yeniden oluşturmadan önce açın), **Günlük klasörünü aç** |

**Arka plan servisi bölümleri — Değişiklikleri kaydet ile kaydedilir:** Bildirimler
(kurallar, sessiz saatler, Rahatsız etme, bildirim dili), Kullanım ve maliyet
(kullanım uyarıları, fiyat tablosu, günlük özet saati), Projeler (todo dosyası deseni,
proje klasörleri, git durumu), Görevler (bitiş hatırlatmaları), Dikte (model, dil,
temizleme, çıktılar, geçmiş) ve Yapay zekâ (özellik başına sağlayıcı ve model, bkz.
[Yapay zekâ sağlayıcıları](#yapay-zekâ-sağlayıcıları); uç noktalar hemen kaydedilir). Bunlar bir
taslağı düzenler: **Değişiklikleri kaydet**
taslağı gönderir, **Vazgeç** atar; servis bir değeri reddederse alan ve bölümü işaretlenir. Bu
bölümler arka plan servisine ihtiyaç duyar; servis yoksa yerlerinde bir uyarı
görünür.

Günlükler bu bilgisayarda kalır; yukarıdakilerin hiçbiri kendiliğinden bir şey
göndermez.

## Temalar ve dil

**Tema:** Koyu (varsayılan), Açık ya da Sistem (Windows'un uygulama kipini izler).
Değiştirmek (Ayarlar → Görünüm ya da komut paletinde varsayılan kısayolu olmayan
**Temayı değiştir**) tüm arayüzü, Monaco'nun editör temasını ve açık her terminalin
renk paletini birlikte günceller; yeniden başlatma gerekmez.

**Dil:** İngilizce ya da Türkçe; "Windows ile aynı", Windows Türkçeyi tercih ediyorsa
Türkçe, değilse İngilizce kullanır. Tüm arayüz ve bu yardım bir anda değişir.
Bildirimler arka plan servisinin bildirim dilini kullanır (Ayarlar → Bildirimler).
