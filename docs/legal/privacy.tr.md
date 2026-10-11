# Kotilo Gizlilik Politikası

Yürürlük tarihi: 2026-10-11

Kotilo, gönüllülerin ("bakımcılar") sürdürdüğü açık kaynaklı bir projedir. Arkasında bir şirket ve bir Kotilo sunucusu yoktur. Bu politika yazılımın davranışını açıklar: Kotilo'nun cihazınızda ne sakladığını ve başka sistemlere bağlandığı birkaç durumu. Kaynak kod: https://github.com/kotilo-dev/kotilo

## 1. Özet

- **Telemetri yok.** Kotilo bakımcılara veya başka birine kullanım analitiği, çökme raporu ya da izleme verisi göndermez.
- **Verileriniz cihazınızda kalır.** Ayarlar, oturum meta verileri, kullanım istatistikleri, görevler ve raporlar yalnızca yerel klasörlerde saklanır.
- **Konuşma içeriği saklanmaz.** İstemler (prompt), ajan yanıtları ve konuşma içeriği Kotilo'nun veritabanına veya log dosyalarına hiçbir zaman yazılmaz; yalnızca meta veriler ve sayılar (örneğin zamanlar, token sayıları, durumlar, araç adları, dosya yolları) saklanır.
- **Ses saklanmaz.** Dikte sesi cihazınızda bellekte işlenir ve hiçbir zaman saklanmaz.
- **Ajan giriş bilgileri okunmaz.** Kotilo hiçbir yapay zekâ ajanının giriş veya token dosyasını okumaz, saklamaz, aktarmaz.
- **Bakımcılara hiçbir şey gitmez.** Kotilo'nun yaptığı hiçbir şey bakımcılara veri göndermez.

## 2. Cihazınızdan çıkan veriler

Kotilo başka sistemlere yalnızca şu durumlarda bağlanır:

| Ne zaman | Alıcı | Gönderilen | Amaç |
|---|---|---|---|
| Güncelleme denetimi: açılıştan birkaç saniye sonra (Ayarlar → Hakkında ve tanılama'dan kapatılabilir) ve **Güncellemeleri denetle**'ye tıkladığınızda | GitHub Releases (github.com ve objects.githubusercontent.com gibi GitHub indirme sunucuları) | En son sürüm bilgisi isteği ve bir güncellemeyi kurduğunuzda yükleyicinin indirilmesi. Her web isteği gibi IP adresinizi ve sıradan bir kullanıcı aracısı (user agent) bilgisini gösterir | Yeni sürümleri bulmak ve kurmak |
| Whisper modeli indirme (yalnızca bir model seçtiğinizde) | Hugging Face (huggingface.co ve indirme sunucuları) | Bir dosya indirme isteği | Yerel dikte için konuşma modelini edinmek |
| Yapay zekâ özellikleri, yalnızca böyle bir özellik çalıştığında (asistan, günlük özet, dikte düzeltmesi, sağlayıcı **Test**'i) | Seçtiğiniz yapay zekâ sağlayıcısı: kurulu ajan CLI'ınız (kendi hesabınızla kendi sağlayıcısına bağlanır) ya da yapılandırdığınız OpenAI uyumlu uç nokta | O özelliğin isteği (örneğin düzeltilecek metin ya da özetlenecek sayılar) ve bir uç nokta için onun adına sakladığınız API anahtarı | Yapay zekâ özelliğini yerine getirmek |

Bunun dışında hiçbir şey gönderilmez. GitHub, Hugging Face ve yapay zekâ sağlayıcıları bu istekleri kendi gizlilik politikaları ve sizinle aralarındaki sözleşmeler çerçevesinde işler; bakımcıların bu verilere erişimi yoktur. Tüm yapay zekâ özellikleri kendi bilgisayarınızdaki bir uç noktayı kullanıyor ve yerel Whisper kullanıyorsanız hiçbir yapay zekâ verisi cihazınızdan çıkmaz (uygulamada **Tamamen yerel** olarak gösterilir).

Kotilo'nun terminallerinde çalıştırdığınız ajanlar ayrı programlardır. Kendi hizmetlerine kendi koşullarıyla bağlanırlar; Kotilo bu trafiği yönlendirmez, okumaz veya değiştirmez. Açtığınız bağlantılar da tarayıcınıza gider.

Windows yükleyicisi, kurulu değilse Microsoft'un WebView2 Runtime bileşenini Microsoft'tan indirebilir.

## 3. Cihazınızda saklanan veriler

Kotilo yerel veri klasörlerinde (Windows'ta `%APPDATA%\kotilo` ve `%LOCALAPPDATA%\kotilo`) şunları saklar:

- ayarlar, çalışma alanı listesi ve pencere düzeni;
- oturum ve kullanım meta verileri (durumlar, zamanlar, token sayıları, maliyetler, projeler, araç adları);
- kişisel görevleriniz, raporlarınız ve günlük özetleriniz;
- besteleyicide (composer) kendiniz kaydettiğiniz istemler;
- tanınan metni (sesi değil) içeren dikte geçmişi; Ayarlar → Dikte'den temizlenebilir veya kapatılabilir;
- konuşma içeriği barındırmayan log dosyaları ve **Tanılama topla** ile kendinizin oluşturduğu tanılama arşivleri (hiçbir yere otomatik gönderilmez);
- indirilen Whisper konuşma modelleri.

Bir yapay zekâ uç noktası için girdiğiniz **API anahtarları** işletim sisteminin kimlik bilgisi kasasında (Windows Kimlik Bilgisi Yöneticisi) saklanır; hiçbir zaman ayar dosyalarına veya log'lara yazılmaz. Ayarlar'daki **Anahtarı kaldır** bir anahtarı siler.

## 4. Ajan ayar dosyaları

Ajan durumunu gösterebilmek için Kotilo, kullandığınız ajanların ayarlarına hook kayıtları veya bir eklenti kurabilir. Bunu yalnızca bir ajan için **Kur**'a tıkladığınızda yapar; önce dosyanın zaman damgalı bir yedeğini alır, dosyadaki diğer her şeyi korur, okuyamadığı bir dosyayı değiştirmeyi reddeder ve **Kaldır** dendiğinde yalnızca kendi kayıtlarını siler. Hook yardımcısı olayları yalnızca kendi bilgisayarınızdaki Kotilo arka plan hizmetine (loopback) bildirir; istem ve yanıt metinleri çıkarılmış olarak.

## 5. Kaldırma

Kaldırmadan önce Ayarlar → Ajanlar'da her ajan entegrasyonu için **Kaldır**'a tıklayın; kaldırıcı ajanlarınızın dosyalarını düzenlemez. Kaldırıcı uygulamayı, kısayollarını ve kayıt defteri girdisini siler. Yeniden kurulumda ayarlarınızın korunması için veri klasörleriniz (bölüm 3) yerinde kalır; tüm verileri silmek için `%APPDATA%\kotilo` ve `%LOCALAPPDATA%\kotilo` klasörlerini silin. Saklanan API anahtarlarını kaldırmadan önce Ayarlar'dan ya da Windows Kimlik Bilgisi Yöneticisi'nden silebilirsiniz.

## 6. Haklarınız

Kotilo verilerinizi cihazınızda tuttuğu ve bakımcılar bunların hiçbirini almadığı için verileriniz doğrudan sizin denetiminizdedir: dilediğiniz zaman görüntüleyebilir ve silebilirsiniz. GitHub'a, Hugging Face'e veya bir yapay zekâ sağlayıcısına gönderdiğiniz veriler onlar tarafından işlenir; bu verilerle ilgili haklarınız için onlara başvurun.

## 7. Çocuklar

Kotilo bir geliştirici aracıdır ve çocuklara yönelik değildir.

## 8. İletişim

Bu politikayla ilgili sorular için https://github.com/kotilo-dev/kotilo/issues adresinde bir konu (issue) açın. Bir gizlilik veya güvenlik sorununu gizli olarak bildirmek için GitHub'ın özel güvenlik açığı bildirimini kullanın (deponun Security sekmesi → **Report a vulnerability**).

## 9. Değişiklikler

Bu politikadaki değişiklikler https://github.com/kotilo-dev/kotilo deposunda yeni bir yürürlük tarihiyle yayımlanır. Cihazınızdan ek veri gönderecek bir değişiklik sürüm notlarında duyurulur.
