# Kısayollar

Tüm kısayollar `Ctrl` kullanır (`Cmd` değil; bu uygulama Windows içindir).
Tuş birleşimleri Kotilo'ın kendi içinde kullandığı biçimde yazılmıştır, örneğin
`` Ctrl+` ``.

## Kapsam modeli

Aşağıdaki her kısayol şu üç gruptan birine girer:

- **Genel**: terminal odaktayken de dahil her yerde çalışır. Tuş kabuğa ulaşmadan
  yakalanır.
- **Terminal dışı**: terminal odakta *değilken* her yerde çalışır; terminal odaktayken
  tuş doğrudan terminalde çalışan kabuğa/programa gider.
- **Terminale özel**: yalnızca terminal odaktayken anlamlıdır (ve yalnızca o zaman
  işlenir); uygulamanın komut kaydına hiç ulaşmaz.

Bu en çok `Ctrl+P` için önemlidir: terminal odaktayken `Ctrl+P` hızlı açmayı açmak
yerine kabuğa/programa gönderilir. Bu bilinçli bir seçimdir; böylece bir ajan
CLI'sinin kendi `Ctrl+P` kısayolu (ve kabuğun geçmiş araması) çalışmaya devam eder.
`Ctrl+Shift+P` (komut paleti) ve `Ctrl+,` (Ayarlar) ise **genel**dir ve terminal
odaktayken bile her zaman açılır.

## Genel

| Kısayol | İşlem |
|---|---|
| `Ctrl+B` | Sol sütunu (Çalışma alanları/Ajanlar) aç/kapat |
| `Ctrl+J` | Terminal sütununu aç/kapat |
| `Ctrl+Shift+U` | Görüntüleyici sütununu aç/kapat |
| `` Ctrl+` `` | Etkin çalışma alanının terminaline odaklan (yoksa bir tane açar) |
| `Ctrl+1` … `Ctrl+9` | N'inci çalışma alanına geç |
| `Alt+1` … `Alt+9` | Çalışma alanı, Genel bakış, Görev kontrol, Kullanım, Raporlar, Projeler, Görevler, Oturumlar, Dikte ekranına git (gezinme şeridi sırası); geneldir, terminalden de çalışır |
| `Ctrl+Shift+A` | Sıradaki bekleyen ajana git (odaktaki panelden sonrakine, başa dönerek) |
| `Ctrl+Tab` | Sonraki görüntüleyici sekmesi (etkin çalışma alanı) |
| `Ctrl+Shift+Tab` | Önceki görüntüleyici sekmesi (etkin çalışma alanı) |
| `Ctrl+Shift+P` | Komut paletini aç |
| `Ctrl+,` | Ayarlar ekranına git |
| `F1` | Yardımı aç (en son bakılan belgede); geneldir, terminalden de çalışır; WebView2'nin kendi F1 kısayolu yoktur |

## Sistem genelinde (dikte)

Kotilo açıkken her programda çalışır; Ayarlar → Dikte'den değiştirilebilir.

| Kısayol | İşlem |
|---|---|
| `Ctrl+Alt+D` | Dikte: basılı tutup konuşun ya da bir kez basıp başlatın, tekrar basıp bitirin |
| `Esc` | Süren dikteyi iptal eder (yalnızca dikte sırasında) |
| `Ctrl+Alt+Shift+D` | Son dikteyi yeniden yapıştırır |

## Komut paleti / hızlı açma

| Kısayol | İşlem |
|---|---|
| `Ctrl+Shift+P` | Komut kipinde açar (ya da açık hızlı açmayı komut kipine geçirir) |
| `Ctrl+P` | Dosya kipinde açar (terminal dışı kapsam; bkz. [Kapsam modeli](#kapsam-modeli)); açık bir komut kipi penceresini dosya kipine geçirir |
| `>` (ilk karakter olarak) | Dosya kipinden komut kipine geçer |
| baştaki `>`'yi silmek | Komut kipinden dosya kipine döner |
| `↑` / `↓` | Seçimi taşı |
| `PageUp` / `PageDown` | Seçimi bir sayfa taşı |
| `Enter` | Seçili dosyayı önizleme sekmesinde aç / seçili komutu çalıştır |
| `Ctrl+Enter` | Seçili dosyayı yeni sabit sekmede aç |
| `Esc` | Kapat |

## Dosya ağacı

Yalnızca ağacın kendisi klavye odağındayken etkindir (satır içi yeniden adlandırma/
oluşturma kutusu, bağlam menüsü ya da onay penceresi açıkken değil; bunlar tuşları
kendileri işler).

| Kısayol | İşlem |
|---|---|
| `↑` / `↓` | Seçimi taşı |
| `←` | Seçili klasörü kapat; zaten kapalıysa üst klasörünü seç |
| `→` | Seçili klasörü (ya da etkin çalışma alanı kökünü) aç |
| `Enter` | Seçili dosyayı önizleme sekmesinde aç (çift tıklamayla aynı); klasörü aç/kapat ya da bir çalışma alanı kökünü etkinleştir |
| `Ctrl+Enter` | Seçili dosyayı yeni sabit sekmede aç |
| `F2` | Seçili öğeyi yeniden adlandır |
| `Delete` | Seçili öğeyi sil (onayla) |
| `Ctrl+V` | Panodaki görseli seçili klasöre kaydet (yalnızca bir klasör ya da çalışma alanı kökü seçiliyken; bkz. [kullanım kılavuzu](user-guide.md#çalışma-alanları)) |
| `Esc` (süzme kutusunda) | Süzgeci temizle |

Satır içi yeniden adlandırma/oluşturma kutuları: `Enter` onaylar, `Esc` vazgeçer.

## Görüntüleyici / editör

| Kısayol | Kapsam | İşlem |
|---|---|---|
| `Ctrl+S` | Terminal dışı | Etkin sekmeyi kaydet |
| `Ctrl+W` | Terminal dışı | Etkin sekmeyi kapat (kaydedilmemişse sorar) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Genel | Etkin çalışma alanında sonraki/önceki sekme |
| `Ctrl+Shift+M` | Terminal dışı | Etkin sekmede Markdown Düzenle ↔ Önizleme geçişi |
| `Shift+Alt+F` | Editöre özel (Monaco) | Belgeyi biçimlendir (JSON: Monaco'nun kendi biçimlendiricisi; XML: Kotilo'ın XML biçimlendiricisi) |
| `Ctrl+F` | Yalnızca PDF görüntüleyici | Belge içi aramayı aç |
| `Esc` | PDF arama kutusu | Aramayı kapat |

Monaco'nun kendi varsayılan kısayolları (bul/değiştir, çoklu imleç, kod katlama vb.)
metin editörünün içinde her zamanki gibi çalışır; yalnızca yukarıdaki
`Ctrl+S`/`Ctrl+W`/`Ctrl+Tab`/`Ctrl+Shift+Tab`/`Ctrl+Shift+M`/`Shift+Alt+F` Kotilo'ın
üstüne eklediği kısayollardır.

## Terminal

Bunlar yalnızca terminal odaktayken geçerlidir.

| Kısayol | İşlem |
|---|---|
| `Ctrl+C` | Seçim varsa kopyalar (ve seçimi kaldırır); yoksa kabuğa SIGINT (kesme) gönderir |
| `Ctrl+V` | Panodaki metni yapıştırır; panoda metin yoksa (örn. bir görsel varsa) kabuğa `^V` gönderir (böylece claude'un kendi görsel yapıştırma kısayolu çalışır) |
| `Ctrl+Shift+C` | Seçimi her zaman kopyalar (seçim kalır) |
| `Ctrl+Shift+V` | Her zaman yalnızca panodaki metni yapıştırır |
| `Ctrl+Shift+F` | Terminal içi aramayı açar |
| `Shift+Insert` | Yapıştırır (`Ctrl+V` ile aynı çok satırlı yapıştırma uyarısından geçer) |
| Sağ tıklama | Seçim varsa kopyalar, yoksa yapıştırır |
| `Enter` (arama kutusunda) | Sonraki eşleşme (`Shift+Enter` öncekini bulur) |
| `Esc` (arama kutusunda) | Aramayı kapatır |

Şunları terminal odaktayken bile kabuk değil Kotilo işler (bkz.
[Kapsam modeli](#kapsam-modeli)):
`Ctrl+B`, `Ctrl+J`, `Ctrl+Shift+U`, `` Ctrl+` ``, `Ctrl+Shift+A`, `Ctrl+1`–`Ctrl+9`, `Alt+1`–`Alt+9`,
`Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+Shift+P`, `Ctrl+,`, `F1`.

`Ctrl+P`, `Ctrl+S`, `Ctrl+W`, `Ctrl+Shift+M` ve yukarıda olmayan her tuş dahil geri
kalan her şey doğrudan terminalde çalışan kabuğa/programa gider.

## Ajanlar

| Kısayol | İşlem |
|---|---|
| `Ctrl+Shift+A` | Sıradaki bekleyen ajana git (geneldir, yukarıya bakın) |
| Bir ajan satırına tıklama | O çalışma alanına/sekmeye git (`Bitti` satırını `Boşta` yapar) |

### İzin kartı

Bir ajan izin beklerken (arka plan servisi isteği biliyorsa) ajanın terminalinin
üstünde gösterilir. Bu tuşlar yalnızca odak kartın içindeyken çalışır; terminal kendi
`Esc` tuşunu korur. Kart görünür ve odaktaki pencerede açılınca odak **Bir kez izin
ver**'e geçer.

| Kısayol | İşlem |
|---|---|
| `Enter` | **Bir kez izin ver** (ajanın kendi tuşunu gönderir: Claude Code için `1`, Codex için `y`); odak bir düğmedeyse o düğmeyi çalıştırır |
| `Esc` | **Reddet** (ajana `Esc` gönderir) |
| `Tab` / `Shift+Tab` | Bir kez izin ver, Bu projede hep izin ver, Reddet ve Terminalde cevapla arasında gezin |

**Terminalde cevapla** kartı o istek için gizler ve terminale odaklanır; böylece
ajanın kendi sorusunu orada cevaplayabilirsiniz.

### Mesaj kutusu

Bir ajanın terminalinin altındaki mesaj alanı (bkz.
[kullanım kılavuzu](user-guide.md#mesaj-kutusu)). Bu tuşlar yalnızca odak mesaj
kutusundayken geçerlidir; mesaj kutusu odağı kendiliğinden almaz.

| Kısayol | İşlem |
|---|---|
| `Enter` | Mesajı ajana gönder (terminaline yapıştırılır, ardından `Enter`) |
| `Shift+Enter` | Mesajda yeni satır |
| `Esc` | Terminale dön (açıksa önce kayıtlı istemler listesini kapatır) |
| `@` + metin | Dosya önerileri: `↑`/`↓` seçer, `Enter` ya da `Tab` ekler, `Esc` listeyi kapatır |
| Panoda görsel varken `Ctrl+V` | Görseli ekle (`.kotilo/attachments/` içine kaydedilir) |

[Zaman akışı](user-guide.md#zaman-akışı) şeridinin henüz kısayolu yok; komut
paletindeki **Görünüm: Zaman Akışını Aç/Kapat**'ı kullanın. Terminal panelini bölmenin
de kısayolu yok (bkz. [Yan yana iki bölme](user-guide.md#yan-yana-iki-bölme)).

## Pencereler

Yardım, komut paleti/hızlı açma, bağlam menüleri ve onay pencereleri (silme, çalışma
alanını kaldırma, kaydedilmemiş değişiklikler, çok satırlı yapıştırma uyarısı, çalışan
terminali kapatma) için geçerlidir:

| Kısayol | İşlem |
|---|---|
| `Esc` | Kapat/vazgeç (odak pencere açılmadan önce odakta olan yere döner) |
| `Enter` | Bir onay penceresinde (kaydedilmemiş değişiklikler, silme, çalışma alanını kaldırma, çalışan terminali kapatma) pencere açılınca otomatik odaklanan ana düğmeyi (örn. **Tümünü kaydet**) çalıştırır. Bağlam menüleri bir öğeye otomatik odaklanmaz; `Enter` ancak `Tab`/ok tuşlarıyla bir öğeye geldikten sonra onu çalıştırır. |
| `Tab` / `Shift+Tab` | Penceredeki denetimler arasında gezin (tarayıcının doğal sekme sırası) |
| Pencerenin dışına tıklama | Kapat/vazgeç (`Esc` ile aynı) |

Çok satırlı yapıştırma uyarısı ayrıca `Enter`'ı **Yapıştır**'a ve `Esc`'yi **Vazgeç**'e
açıkça bağlar (yalnızca "odaktaki düğmeyi çalıştırır" değil); böylece "Bir daha sorma"
kutusunu yeni işaretlemiş olsanız bile çalışır.
