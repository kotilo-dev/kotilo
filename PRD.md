# Kotilo – Product Requirements

> Ürün adı: **Kotilo** (Fince "salyangoz kabuğu"; *koti* = ev). Maskot robot bir salyangoz. Ürün adında, ikonunda ve paket kimliğinde "Claude", "Anthropic" ya da başka bir ajan sağlayıcısının adı/logosu **kullanılmaz** (bkz. §8). Repo iç adları (`agent-hub` klasörü, `AgentHub.sln`, `agenthub-*` crate'leri, `AGENTHUB_*` ortam değişkenleri) çalışma adından kalır (D-044).
> Durum: taslak v0.1 · 2026-10-04 · Kaynaklar: Claude Control Center (CCC) 0.8.0, AgentDeck Faz 7.

## 1. Özet

AI kodlama ajanlarıyla (Claude Code, Codex CLI, GitHub Copilot CLI, Gemini CLI, OpenCode, Cursor CLI …) aynı anda çalışan geliştiriciler için **tek masaüstü çalışma alanı**: ajanlar gerçek terminallerde çalışır; ürün her ajanın durumunu (çalışıyor / izin bekliyor / cevap bekliyor / bitti) canlı izler, izin isteklerini öne çıkarır, token / maliyet / plan limitlerini gösterir, proje ve kişisel görevleri tutar, her uygulamaya sesli dikte yapar.

İki mevcut uygulamanın birleşimidir:

| Kaynak | Getirdiği |
|---|---|
| **AgentDeck** (Tauri 2, Rust + React) | Çalışma alanı: dosya ağacı, ConPTY terminal sekmeleri, Monaco görüntüleyici/editör, komut paleti, ajan paneli, hook sidecar'ı |
| **Claude Control Center** (.NET 10) | Arka plan zekâsı: hook toplama, durum makinesi, transcript'ten kullanım/maliyet, plan limitleri, projeler/todo ilerlemesi, kişisel görevler, günlük özet, Whisper dikte, bildirim kuralları, sağlık izleme |
## 2. Problem

- Birden çok ajan paralel çalışırken hangisinin izin ya da cevap beklediği kaçırılıyor; ajan dakikalarca boşta bekliyor.
- Her ajanın limiti, maliyeti ve oturum kayıtları farklı yerde ve farklı biçimde; toplam resim yok.
- Terminal pencereleri, editör, notlar ve dikte farklı araçlarda dağınık.
- Mevcut araçlar ya tek ajana özel (çoğu Claude Code), ya Mac'e özel, ya da yalnızca kullanım sayacı (ücretsiz ve kolay kopyalanır).

## 3. Hedef kullanıcı

- **Birincil:** Windows'ta günde birden çok ajan oturumu açan profesyonel geliştirici (bireysel, Pro/Max/Plus/Copilot aboneliği olan).
- **İkincil:** Aynı kişinin ekibi (paylaşılan görünüm, sonraki sürüm).
- **Sonra:** macOS kullanıcıları (finansal olarak önemli; mimari baştan buna hazır kurulur, §9).

## 4. Değer önerisi

1. **Hiçbir izin isteğini kaçırma:** canlı durum, izin kartı (izin ver / reddet / hep izin ver), görev kontrol ekranı, akıllı bildirimler.
2. **Tüm ajanlar tek yerde:** gerçek terminal korunur; etrafındaki çerçeve ajanı tanır (model, branch, context, maliyet, zaman akışı, değişen dosyalar).
3. **Maliyet ve limit görünürlüğü:** ajan bazında token/maliyet, 5 saatlik/haftalık limitler (sağlayıcı izin verdiği ölçüde).
4. **Yerel ve gizli:** sunucu yok; ses bilgisayarda metne çevrilir; AI işleri kullanıcının kendi ajan CLI'ı ile yapılır.

## 5. Kapsam

### 5.1 v1 (Windows) – Must

| Alan | Gereksinim | Kaynak |
|---|---|---|
| Çalışma alanı | Workspace (klasör) ekleme, dosya ağacı, terminal sekmeleri (pwsh, cmd, Git Bash, WSL), Monaco görüntüleme/düzenleme, Markdown/PDF/görsel önizleme, komut paleti, Ctrl+P dosya açma | AgentDeck |
| Ajan başlatma | Kurulu ajanları algıla, profil ile başlat, yeniden açılışta otomatik başlatma yok, kapatırken nazik kapanış | AgentDeck |
| Ajan durumu | Normalleştirilmiş durumlar: Working, WaitingPermission, WaitingInput, Done, Idle, Error, Stale, Ended. Hook'u olan ajanlarda hook, olmayanlarda sezgisel (çıktı akışı / ekran kuralları) | İkisi |
| Ajan adaptörleri | **Claude Code, Codex CLI, GitHub Copilot CLI, Gemini CLI, Qwen Code, Factory Droid, OpenCode, Cursor CLI** (§5.4) | Yeni |
| Ajan başlık şeridi | Ajan, proje · branch · model, animasyonlu durum, tur süresi, context %, token/maliyet, ilgili plan limiti | Mockup 1 |
| İzin kartı | İzin beklenince pencere vurgusu + kart: araç, komut/dosya, risk etiketi, Allow once / Always / Deny (ajanın kendi seçenek tuşlarını gönderir), "terminalde cevapla" yedeği | Mockup 2 |
| Zaman akışı | Araç çağrıları, plan/todo ilerlemesi, değişen dosyalar ve Monaco diff | Mockup 1 |
| Görev kontrol | Tüm ajanlar canlı önizlemeli kartlar, filtreler, limit şeridi, karta tıklayınca ilgili sekme | Mockup 3 |
| Bildirimler | Kural motoru (izin, cevap, bitti, sessiz, hata, limit, context), sessiz saatler, Rahatsız etme, ajanın terminali öndeyse bastırma, tek sahip (çift bildirim yok) | CCC |
| Kullanım ve maliyet | Ajan başına transcript/DB okuyucu, fiyat tablosu, günlük/haftalık/aylık, proje ve müşteri bazında rapor, CSV/Excel | CCC |
| Plan limitleri | Claude (statusLine), Codex (rollout `rate_limits`), Copilot (statusLine, kısmi); diğerleri "bilinmiyor" | CCC + araştırma |
| Projeler | Proje keşfi, todo dosyası ilerlemesi, git durumu | CCC |
| Kişisel görevler | Hızlı görev penceresi (global kısayol), son tarih, öncelik, hatırlatma | CCC Faz 8 |
| Dikte | Global kısayol, yerel Whisper (large/small), isteğe bağlı AI düzeltme, odaktaki alan / pano / dosya; ayrıca giriş kutusunda mikrofon | CCC Faz 9 |
| Tıklanabilir dosya yolları | Terminalde geçen dosya yolları (`src/approval.ts:42`, `C:\…\file.cs(12,5)`) bağlantıya dönüşür; tıklayınca görüntüleyicide ilgili satırda açılır. Yalnızca workspace içindeki var olan dosyalar | Yeni |
| Asistan ve özet | Küçük sohbet ve günlük özet; kullanıcının **seçtiği** AI sağlayıcısıyla (§5.5): ajan CLI'ı (claude -p, codex exec, …, araçlar kapalı) veya OpenAI uyumlu uç nokta | CCC Bip, genelleştirilmiş |
| Yerel / özel LLM desteği | Özel ajan tanımı, açık entegrasyon protokolü ve OpenAI uyumlu AI sağlayıcısı (§5.5) | Yeni |
| Dil | Arayüz İngilizce + Türkçe | CCC |
| Kurulum ve güncelleme | Kullanıcı başına kurulum (yönetici izni yok), otomatik güncelleme, kod imzalı | Yeni |
| Lisans | Ücretsiz ve açık kaynak (Apache-2.0); tüm özellikler herkese açık | Yeni (§7) |

### 5.2 v1 – Should

- Giriş kutusu (composer): `@dosya` önerisi, görsel yapıştırma, dikte, kayıtlı prompt'lar; terminale gönderir.
- Bölünmüş panel (iki ajan yan yana).
- Kenar çubuğunda oturum kartları (son mesaj, süre).
- Maskot / masaüstü göstergesi: robot salyangoz (spiral kabuk, durum renginde çekirdek ve antenler; CCC'deki Bip'in yerine) – isteğe bağlı.

### 5.3 Sonraki sürümler

- **macOS** (v2): aynı arayüz; Mac platform katmanı (§9).
- Kiro, Goose, Cline, Antigravity CLI, Windsurf/Devin, Aider adaptörleri (sinyal kalitesine göre).
- Takım kullanımı: paylaşılan proje görünümü (sunucusuz kalarak).
- PowerToys Command Palette uzantısı (yerel API üzerinden).

### 5.4 Ajan adaptörü kabul kriterleri

Her adaptör için şunlar karşılanınca "destekleniyor" denir:

1. Ajan yüklüyse algılanır ve terminalde başlatılabilir.
2. Hook / eklenti kurulumu tek tıkla yapılır, kaldırılır, kullanıcının kendi kayıtlarına dokunulmaz, önce yedek alınır.
3. En az Working ↔ Done ayrımı doğrudur; ajan destekliyorsa WaitingPermission / WaitingInput da doğrudur.
4. Oturum doğru projeye ve (ürün içinde başlatıldıysa) doğru terminal sekmesine bağlanır.
5. Ajan token verisi yazıyorsa maliyet hesaplanır; yazmıyorsa "veri yok" gösterilir, uydurulmaz.
6. Fixture'lı birim testleri vardır (gerçek kayıt örnekleri, kişisel veri temizlenmiş).

| Ajan | Durum kaynağı | İzin/cevap sinyali | Maliyet | Limit |
|---|---|---|---|---|
| Claude Code | Hooks (`~/.claude/settings.json`) | Var | JSONL transcript | statusLine `rate_limits` |
| Codex CLI | Hooks (`~/.codex/hooks.json` / `config.toml`) | Var (PermissionRequest) | Rollout JSONL `token_count` | Rollout `rate_limits` |
| Copilot CLI | Hooks (`~/.copilot/hooks/*.json`) | Var | `session-state/*/events.jsonl` | Kısmi (statusLine) |
| Gemini CLI | Hooks (`~/.gemini/settings.json`) | Var (Notification) | `tmp/<hash>/chats/*.jsonl` | Yok |
| Qwen Code | Hooks | Var | `~/.qwen/projects/*/chats/*.jsonl` | Yok |
| Factory Droid | Hooks (`~/.factory/hooks.json`) | Var | `~/.factory/sessions/**` | Yok |
| OpenCode | JS eklentisi (`permission.asked`, `session.idle`) | Var | SQLite `opencode.db` | Yok |
| Cursor CLI | Hooks (`~/.cursor/hooks.json`) | Kısmi | Yok (transcript'te token yok) | Yok |

(Yollar ve olay adları 2026-10 araştırmasından; her adaptör yazılırken resmi dokümandan yeniden doğrulanır.)

### 5.5 Yerel ve özel LLM'ler

Kendi modelini (yerel ya da şirket içi) kullanmak isteyenler için üç kodsuz giriş noktası. Ürünün kendisi hiçbir özel/şirket içi LLM'i içermez; bunlar kullanıcı tarafında, ürünün dışında tanımlanır.

1. **Yerel model destekleyen ajanlar:** OpenCode, Qwen Code, Goose, Aider, Codex (`--oss`) gibi ajanlar Ollama, LM Studio, llama.cpp, vLLM ve OpenAI uyumlu sunucularla çalışır. Bu ajanların adaptörleri yerel model kullanıcılarını doğrudan kapsar; ürün modelle doğrudan konuşmaz.
2. **Özel ajan tanımı:** Kullanıcı `%APPDATA%\kotilo\adapters\<id>\adapter.json` (Mac: `~/Library/Application Support/kotilo/adapters/`) dosyasıyla kendi ajanını ekler: başlatma komutu, tanıma kuralları, izin tuşları, nazik kapanış, ekran kuralları. Ajan listede görünür, terminalde çalışır; durum, protokol (3) kullanılmıyorsa sezgisel olarak (çıktı akışı / ekran kuralları) belirlenir. Ayarlar ekranında "Add custom agent" sihirbazı ve doğrulama.
3. **Açık entegrasyon protokolü (Agent Integration Protocol v1):** Herhangi bir ajan durumunu bildirebilir: `kotilo-hook --agent <id> --event <event>` çağırarak ya da yerel uç noktaya JSON göndererek. Olaylar: `session-start`, `working`, `waiting-permission` (araç, komut/dosya, risk), `waiting-input` (soru), `done`, `error`, `session-end`, isteğe bağlı `usage` (model, giriş/çıkış token). Böylece izin kartı, bildirim, görev kontrol ve kullanım bu ajanlarda da çalışır. Protokol belgelenir ve sürümlenir (`docs/agent-protocol.md`).

**AI sağlayıcısı (uygulamanın kendi AI işleri):** asistan, günlük özet ve dikte düzeltmesi için seçilebilir sağlayıcı:
- **Ajan CLI'ı** (varsayılan): kullanıcının kurulu CLI'ı headless; anahtar istemez.
- **OpenAI uyumlu uç nokta:** temel adres + model + isteğe bağlı anahtar (Ollama, LM Studio, llama.cpp server, vLLM, şirket içi ağ geçitleri). Anahtar Windows Kimlik Bilgisi Yöneticisi / macOS Keychain'de saklanır; log'a ve ayar dosyasına yazılmaz.
- Yerel sağlayıcı + yerel Whisper seçildiğinde hiçbir veri bilgisayardan çıkmaz ("fully local" rozeti).
- Anahtar alanı **isteğe bağlıdır**: Microsoft Store politikası 10.8.3, API anahtarı *gerektiren* uygulamalar için Company hesabı ister.

**v1'de kod eklentisi (plugin) sistemi yok:** üçüncü taraf kodu çalıştırmak güvenlik ve bakım riski. Talep olursa v2'de sandbox'lı JS/WASM eklentileri değerlendirilir.

## 6. Kullanıcı hikâyeleri (seçme)

- Üç ajan paralel çalışırken biri izin istediğinde, hangi pencerede olursam olayım bildirim alırım; bildirime ya da görev kontrol kartına tıklayınca o ajanın sekmesine ve izin kartına giderim.
- İzin kartında komutu ve risk etiketini görürüm, tek tıkla izin veririm; ajan çalışmaya devam eder.
- Gün sonunda hangi ajana / projeye ne kadar harcadığımı ve limitlerimin ne durumda olduğunu tek ekranda görürüm.
- Bir ajan "bitti" dediğinde değişen dosyaları ve diff'i yan panelde incelerim.
- Notepad'de ya da tarayıcıda kısayola basılı tutup konuşurum; metin yazılır.
- Ürünü kurarken mevcut hook'larım, statusLine'ım ve ajan ayarlarım bozulmaz; kaldırınca kendi kayıtları temizlenir.
- Ajanın çıktısındaki `src/approval.ts:42` yoluna tıklarım; dosya görüntüleyicide 42. satırda açılır.
- Şirketimin iç ajanını bir tanım dosyası ve hook çağrısıyla eklerim; izin istediğinde diğer ajanlar gibi bildirim alırım.
- Asistan ve günlük özet için yerel Ollama modelimi seçerim; hiçbir veri bilgisayarımdan çıkmaz.

## 7. Dağıtım modeli

Karar (2026-10-09, D-047): ürün **ücretsiz ve açık kaynak, Apache-2.0**. Ücretli katman yok: rakiplerin çoğu ücretsiz/açık kaynak, ajan sağlayıcıları aynı özellikleri kendi ürünlerine ekliyor ve ajan değişikliklerini takip etmek tek kişi için ağır. Açık kaynak, ajan ayarlarına hook ekleyen bir uygulamaya güveni ve adaptör katkılarını kolaylaştırır.

- Herkese açık repo: temizlenmiş ağaçtan tek başlangıç commit'iyle yeni bir repo; özel repo geçmişiyle birlikte özel kalır.
- Dağıtım: GitHub Releases (x64 + ARM64 NSIS kurucu, Tauri updater için `latest.json`); ileride winget ve Microsoft Store ücretsiz listesi.
- Kod imzası: ilk sürüm imzasız (ya da kendi sertifikası), ardından SignPath Foundation başvurusu (OSS için ücretsiz; CI'dan doğrulanabilir derleme, sürüm başına onay, "Code signing policy" bölümü).
- Destek: GitHub Issues/Discussions; isteğe bağlı GitHub Sponsors.

## 8. Uyumluluk ve kısıtlar

- **Marka:** Ürün adı, logosu, alan adı, paket/Store kimliği hiçbir sağlayıcı markası içermez. Açıklamada düz metinle "works with Claude Code, Codex, …" ve "not affiliated with …" notu. Ajanlar arayüzde harf + renkle ayırt edilir, sağlayıcı logosu ürün markası gibi kullanılmaz.
- **Hesap/kimlik bilgisi:** Ürün hiçbir ajanın giriş bilgisini (OAuth token, `.credentials.json`, API anahtarı dosyası) **okumaz, saklamaz, aktarmaz**. AI işleri yalnızca kullanıcının kurulu, değiştirilmemiş CLI'ı headless çalıştırılarak yapılır. Zamanlanmış otomatik çağrılar seyrek ve kapatılabilir.
- **Ajan ayar dosyaları:** Yalnızca belgelenmiş uzantı noktaları (hooks, statusLine, eklenti klasörleri) kullanılır; değişiklikten önce yedek; geçersiz JSON'a dokunulmaz; kaldırırken yalnızca kendi kayıtları silinir.
- **Gizlilik:** Telemetri yok (v1). Transcript içeriği veritabanına ve log'a yazılmaz; yalnızca metadata ve sayılar. Ses saklanmaz.
- **Açık kaynak lisansları:** Tüm bağımlılıkların bildirimleri ürünle dağıtılır (THIRD_PARTY_NOTICES).
- **Şirket içi / kapalı kod yok:** herhangi bir işverene ait, şirket içi ya da kapalı kaynak kod veya entegrasyon taşınmaz.

## 9. Platform stratejisi

- v1 yalnızca Windows 11 (x64, ARM64).
- macOS v2; finansal önceliği yüksek. Bu yüzden v1'de: tek arayüz Tauri/React; iş mantığı platformdan bağımsız; işletim sistemine özel kod ayrı bir platform katmanında (ARCHITECTURE §6). Windows'a özel API'ler bu katmanın dışına sızmaz.

## 10. Başarı ölçütleri (yerel, telemetrisiz)

- Hook'tan arayüze durum gecikmesi < 300 ms; bildirim < 1 s.
- İzin bekleme süresinin medyanı (kullanıcının kendi raporunda) ürün kullanımıyla düşer.
- Sıfır "ayar dosyamı bozdu" vakası: tüm yazmalar yedekli ve testli.
- Benimsenme: ilk 90 günde GitHub yıldızı, sürüm indirmeleri ve dışarıdan katkıyla gelen adaptörler (herkese açık sayılar, telemetri yok).

## 11. Yol haritası (öneri)

| Kilometre taşı | İçerik |
|---|---|
| M0 – Temel | Monorepo, AgentDeck'in aktarımı, CCC çekirdeğinin hub servisi olarak aktarımı, derleme/test hattı |
| M1 – Adaptör katmanı | Normalleştirilmiş oturum modeli, adaptör arayüzü, Claude Code + **Codex** adaptörleri, ortak hook sidecar'ı |
| M2 – Arayüz birleşimi | CCC ekranlarının React'e taşınması (Genel bakış, Kullanım, Raporlar, Görevler, Dikte, Ayarlar), ajan başlık şeridi, izin kartı |
| M3 – Diğer ajanlar | Copilot CLI, Gemini, Qwen, Droid, OpenCode, Cursor; özel ajan tanımı, Agent Integration Protocol v1, OpenAI uyumlu AI sağlayıcısı |
| M4 – Görev kontrol + polish | Mission control, zaman akışı + diff, composer, tasarım sistemi uygulaması |
| M5 – Açık kaynak sürüm | Marka, paketleme, Tauri updater (GitHub Releases), CI, kod imzası, açık kaynak bildirimleri, gizlilik, katkı belgeleri, herkese açık repo ve v0.1.0 |
| M6 – macOS | Platform katmanının Mac uygulaması, notarization |

## 12. Açık sorular

1. Dikte motoru Mac'te de C# hub'da mı kalacak, yoksa Rust'a (whisper-rs + cpal) mı taşınacak (ARCHITECTURE §10).

Kapananlar: Free/Pro sınırı, fiyat, deneme/iade, vergi kapsamı – ücretli katman yok (D-047); nihai marka Kotilo, repo `kotilo-dev/kotilo` (D-049).
