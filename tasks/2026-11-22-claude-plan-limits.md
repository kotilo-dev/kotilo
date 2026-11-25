# Claude Code'un 5 saatlik ve haftalık limitlerini göstermek

**Durum:** TAMAMLANDI
**Tarih:** 2026-11-22 (son güncelleme: 2026-11-22)
**Etkilenen yer:** `crates/hook` (yeni ikinci program), `apps/desktop/src-tauri` (paketleme), `hub/Hub.Service` (kurulumun bağlanması), ayarlar ekranı, README, `docs/DECISIONS.md`. Kullanıcının `~/.claude/settings.json` dosyasındaki `statusLine` alanı, yedek alınarak ve yalnızca açık onayla değiştirilir. SAP'a yazma yok.

## A. BRIEF (işe başlamadan önce)

### Özet
Claude Code, plan limitlerini (5 saatlik pencere, haftalık pencere, yüzde ve sıfırlanma zamanı) yalnızca "status line" komutuna JSON olarak veriyor. Kotilo'da bu JSON'u alan hub uç noktası, ayrıştırıcı, limit deposu, arayüzdeki gösterim yerleri ve Claude ayarlarına yazan yükleyici zaten var. Eksik olan yalnızca Claude'un çağıracağı küçük `kotilo-statusline` programı ve onu kuran/kaldıran ayar. Bu iş o eksikleri tamamlar.

### Arka plan
- **Status line:** Claude Code'un terminalin altındaki satırı çizmek için her güncellemede çalıştırdığı komut. `~/.claude/settings.json` içinde `statusLine: { type: "command", command: "..." }` olarak duruyor. Tek yuva var: aynı anda yalnızca bir komut tanımlanabiliyor.
- **Zincirleme (chaining):** Kullanıcının kendi status line komutu varsa Kotilo onu silmez. Komut `statusline.json`'a saklanır, `kotilo-statusline` önce JSON'u hub'a iletir, sonra kullanıcının komutunu aynı JSON'la çalıştırıp onun çıktısını basar. Kaldırmada eski komut geri yazılır. Bu kurgu hub'da zaten yazılı (`ClaudeSettingsMerger.InstallStatusLine/UninstallStatusLine`, `AppSettings` "wrapped statusLine").
- **Hazır olanlar:** `POST /v1/statusline` (`IngestServer.cs`), `StatusLineSnapshot` + `PlanLimits.Parse`, `PlanLimitStores` (ajan başına), `GET /v1/limits`. Ekranda Usage sayfası, Overview, Mission control, ajan şeridi ve tray menüsü. Codex limitleri bugün bu yollardan gösteriliyor.
- **Eksik olanlar:** (1) `kotilo-statusline` programı. (2) Programın uygulamayla paketlenmesi. (3) `AppHost.InstallStatusLine()` hiçbir yerden çağrılmıyor, yani açıp kapatacak bir ayar ve API yok.
- **Hook programı:** `crates/hook` (`agenthub-hook`, paketlenmiş adı `kotilo-hook`). Hub'a kısa zaman aşımlı HTTP gönderen `post_event` fonksiyonu burada hazır.

### Kapsam / Kapsam dışı
**Kapsam**
- **Program:** `crates/hook` içine ikinci bir çalıştırılabilir dosya (`[[bin]]`) olarak `kotilo-statusline`. Hook'un HTTP ve port/token okuma kodunu yeniden kullanır. Görevi: stdin'deki JSON'u hub'a `POST /v1/statusline` ile kısa bir süre sınırıyla (≤150 ms) göndermek. Hub kapalıysa sessizce devam etmek. Ardından saklanmış kullanıcı komutu varsa onu aynı JSON'la çalıştırıp çıktısını basmak, yoksa kısa bir Kotilo özeti basmak (aşağıdaki karar 2). Hiçbir zaman hata koduyla çıkmaz ve Claude'u bekletmez.
- **Paketleme:** `tauri.conf.json` `externalBin` listesine eklenir. `ToolInstaller` programı zaten `hub\bin` klasörüne kopyalayacak şekilde yazılmış.
- **Kurulum:** Hub API'sine statusLine kur/kaldır ucu eklenir. Ayarlar → Agents → Claude Code altına bir anahtar konur. Kurulum yedek alarak yazar. Geçersiz JSON'a dokunmaz (AGENTS.md kural 4).
- **Ekran:** Yeni ekran yok. Claude limitleri mevcut yerlerde (Usage, Overview, Mission control, ajan şeridi, tray) Codex'inkilerle aynı biçimde görünür. Bunu doğrulayan test ve ekran görüntüsü eklenir.
- **Belgeler:** README tablosu ("Plan limits not shown yet" kalkar), `docs/DECISIONS.md` kaydı, gerekiyorsa `docs/manual-tests.md`.

**Kapsam dışı**
- Diğer ajanların limitleri (ayrı araştırma).
- Claude'un `spend_limit` alanı: ayrıştırılıyor ama gösterimi bu işin parçası değil.
- macOS/Linux paketleme denemesi: kod platformdan bağımsız kalacak, yalnızca Windows'ta denenecek.

### Plan
- [ ] 1. `crates/hook`: `kotilo-statusline` ikinci bin. Hub'a gönderme, zincirleme, kendi özeti, testler (sahte hub, zaman aşımı, kullanıcı komutu çıktısı ve hata durumu).
- [ ] 2. Paketleme: `externalBin`, build betikleri (`scripts/`), `ToolInstaller` kopyalaması.
- [ ] 3. Hub: kur/kaldır API ucu + durum (kurulu mu, zincirlenen komut var mı). Testler geçici klasörde, gerçek `~/.claude`'a asla dokunmadan.
- [ ] 4. Ayarlar ekranı: anahtar, açıklama metni (EN+TR), zincirlenen komut varsa bilgi satırı.
- [ ] 5. Ekran doğrulaması: Claude limitlerinin Usage, Overview, ajan şeridi ve tray'de göründüğünü gösteren birim + e2e testleri ve ekran görüntüleri.
- [ ] 6. Belgeler: README, DECISIONS, manual-tests.
- [ ] 7. Doğrulama: `cargo test --workspace`, `cargo clippy ... -D warnings`, `dotnet test hub/AgentHub.sln`, UI build/test/e2e. Gerçek Claude Code ile elle deneme kullanıcıda.

### Riskler ve varsayımlar
- **Hız:** Claude status line'ı sık çalıştırır. Program yavaşlarsa Claude'un alt satırı gecikir. Bu yüzden hub'a gönderim için katı bir süre sınırı var ve kullanıcı komutu hub'ı beklemeden çalışır.
- **Kullanıcının ayarı:** Kural 4 gereği yalnızca yedekli birleştirici kullanılır. Kaldırmada kullanıcının eski komutu geri gelir.
- **Varsayım:** Claude Code'un status line JSON'undaki `rate_limits` alanları (`five_hour`, `seven_day`, `used_percentage`, `resets_at`) hâlâ aynı adlarla geçiyor. Uygulamadan önce Claude Code'un güncel belgesinden yeniden doğrulanacak (AGENTS.md: tahmin yok).
- **Varsayım:** Limitler yalnızca Pro/Max aboneliğinde ve oturumun ilk API yanıtından sonra gelir. API anahtarıyla kullananlarda ekranda bir şey görünmez. Bu beklenen davranış.

### ⚠ Senden beklenenler (başlamadan önce)
| # | Karar / eylem | Neden gerekli | İşi durduruyor mu? (Evet/Hayır) | Cevap |
|---|---|---|---|---|
| 1 | Status line nasıl kurulsun? (a) Ayarlarda kapalı başlayan bir anahtarla, kullanıcı açınca. (b) Claude hook'ları kurulurken otomatik, zincirleme ile. Önerim: (a). | Kullanıcının Claude ayarındaki tek yuvayı değiştiriyoruz. Açık onay daha güvenli. | Evet | 2026-11-22: (a) |
| 2 | Kullanıcının kendi status line'ı yoksa Claude'un alt satırında ne yazsın? Önerim kısa bir özet: `5h 42% (2s 10dk) · hafta 18% · ctx 37%`. Alternatif: hiçbir şey basmamak. | Claude'un alt satırı boş kalmaz, limitler terminalde de görünür. | Evet | 2026-11-22: Kısa özet. Terminal metni dilden bağımsız, İngilizce kısaltmalarla: `5h 42% (2h10m) · wk 18% · ctx 37%`. |
| 3 | Bu brief'i onayla. | Kullanıcının Claude ayar dosyasına yazan bir özellik. | Evet | 2026-11-22: Onaylandı ("önerinle devam"). |

### Kararlar
- 2026-11-22: Kullanıcı Claude Code limitlerini bu sürüme almayı onayladı ("alalım").
- 2026-11-22: Kullanıcı önerileri onayladı: ayarlarda kapalı başlayan anahtar, kendi status line yoksa kısa özet.
- 2026-11-22: Claude Code belgesi doğrulandı (code.claude.com/docs/en/statusline.md, hooks.md). `rate_limits.five_hour/seven_day` alanları `used_percentage` (0–100) ve `resets_at` (Unix saniyesi) taşıyor. Yalnızca Pro/Max/Ultra'da ve oturumun ilk API yanıtından sonra geliyor. Status line 300 ms gecikmeyle (debounce) çalışıyor. Yeni bir güncelleme gelince çalışan betik iptal ediliyor. Çıktı yalnızca çıkış kodu 0 ise gösteriliyor, sıfır dışı kodda satır boş kalıyor. Yavaş betik satırın güncellenmesini engelliyor. Zaman aşımı belgelenmemiş. Ayar biçimi: `type`, `command`, isteğe bağlı `padding`, `refreshInterval`, `hideVimModeIndicator`. Kurulum bu alanları korumalı. Hub ayrıştırıcısı `resets_at`'i zaten Unix saniyesi olarak okuyor.

- 2026-11-22: İnceleme sırasında ana oturum bir değişiklik yaptı. Kullanıcının zincirlenen komutu Windows'ta `cmd.exe` yerine Git Bash ile çalışıyor, çünkü Claude Code da komutlarını Git Bash'te çalıştırıyor. Git Bash yoksa `cmd.exe` kullanılıyor. Hiçbir şey basmayan bir kullanıcı komutunda alt satır boş kalmıyor, özet gösteriliyor.

## B. RAPOR (iş bittikten sonra)
### Sonuç
Claude Code'un 5 saatlik ve haftalık limitleri artık gösterilebiliyor. Bunun için Ayarlar → Agents → Claude Code altındaki "Show plan limits (status line)" anahtarını açmak gerekiyor. Gerçek bir Claude Pro/Max oturumuyla henüz denenmedi.

### Yapılanlar
- **Yardımcı program** (`kotilo-statusline`, `crates/hook` içinde ikinci program): Claude'un JSON'unu en fazla 150 ms içinde hub'a iletiyor. Kullanıcının kendi komutu varsa onu aynı girdiyle çalıştırıp çıktısını basıyor, yoksa `5h 42% (2h10m) · wk 18% · ctx 37%` özetini basıyor. Her durumda çıkış kodu 0. Kullanıcı komutu 5 saniyede, programın kendisi 7 saniyede kesiliyor.
- **Paketleme:** `externalBin`, `build.rs` ve üç platformun sürüm betikleri güncellendi.
- **Hub:** `GET /v1/adapters/claude-code/statusline`, `POST …/install`, `POST …/uninstall` uçları eklendi. Hata durumları: 409 yardımcı program yok, 422 geçersiz ayar dosyası, 500 G/Ç hatası. Kurulum `padding`, `refreshInterval` ve `hideVimModeIndicator` alanlarını koruyor. Geçersiz JSON'a dokunmuyor.
- **Ayarlar:** Claude Code kartına kapalı başlayan bir anahtar eklendi (EN+TR). Bir kullanıcı komutu zincirleniyorsa bilgi satırı gösteriliyor.
- **Belgeler:** README, `docs/DECISIONS.md` D-078, `docs/hub-api.md`, `docs/manual-tests.md` (PL-1…PL-8).
- **Diğerleri:** Kodu bir Sonnet alt ajanı yazdı. Ana oturum inceledi ve Git Bash değişikliğini yaptı (Kararlar'a bakın).

### Nasıl doğrulandı
- **Alt ajanın çalıştırması:** `cargo clippy --workspace -D warnings` temiz. `dotnet test` sonucu Core 745, Infrastructure 265, Service 94, hepsi geçti. UI build geçti. UI birim testlerinin 1093'ü geçti. e2e testlerinin 139'u geçti. `cargo test --workspace` içinde iki test tam çalıştırmada başarısız olup tek başına geçti (`pty::ctrl_c…`, `gitcli::worktree…`). İkisi de bu işle ilgisiz ve yükten kaynaklanan geçici hatalara benziyor.
- **Ana oturum, değişiklikten sonra:** `agenthub-hook` paketinin testleri 81 + 1 + 1 + 2 geçti, clippy temiz. Bu makinede testler Git Bash üzerinden çalıştı.
- **Gerçek çalıştırılabilir dosya:** Sahte bir Claude JSON'u verildiğinde `5h 42% (2h10m) · wk 18% · ctx 37%` bastı, çıkış kodu 0.
- **Ekran görüntüleri:** `limits-settings-dark.png`, `limits-header-strip-dark.png`, `limits-overview-*.png`.
- **Doğrulanmayan:** Program gerçek bir Claude Code oturumunda hiç çalışmadı. Anahtar da gerçek ayar dosyasında hiç açılmadı.

### Değişen nesneler / dosyalar
- **Rust:** `crates/hook/Cargo.toml`, `crates/hook/src/{statusline.rs,statusline_main.rs,lib.rs}`, `crates/hook/src/platform/{mod,windows,other}.rs`, `crates/hook/tests/statusline.rs`, `apps/desktop/src-tauri/build.rs`, `apps/desktop/src-tauri/tauri.conf.json`.
- **Betikler:** `scripts/release.ps1`, `scripts/release-linux.sh`, `scripts/release-macos.sh`.
- **Hub:** `hub/Hub.Infrastructure/Claude/ClaudeSettingsMerger.cs`, `hub/Hub.Service/Api/StatusLineEndpoints.cs`, `hub/Hub.Service/Hosting/AppHost.cs`, testler (`StatusLineApiTests.cs`, `StatusLineMergerTests.cs`).
- **Masaüstü:** `features/settings/{AgentsSection.tsx,controls.tsx,AgentsSection.test.tsx}`, `app/i18n/agentSetup.{en,tr}.ts`, `lib/hubTypes.ts`, `src/e2e/{fixtures,setup}.ts`, `e2e/{usage,limits}.spec.ts`.
- **Belgeler:** `README.md`, `docs/DECISIONS.md`, `docs/hub-api.md`, `docs/manual-tests.md`.

### Yapılmayanlar ve açık kalanlar
- **Usage sayfası:** Bu kod tabanında limitler Usage sayfasında hiç gösterilmiyor, Overview, Mission control, ajan şeridi ve tray'de gösteriliyor. Brief'teki "Usage" ifadesi hatalıydı, sayfa değiştirilmedi.
- **Haftalık pencere:** Özette haftalık pencere için kalan süre yok, yalnızca yüzde var (`wk 18%`). Örnekteki gibi kısa tutuldu.
- **`spend_limit`:** Gösterilmiyor (kapsam dışı).

### ⚠ Senden beklenenler (şimdi)
| # | Eylem | Neden | Aciliyet | İşi durduruyor mu? (Evet/Hayır) |
|---|---|---|---|---|
| 1 | Dev sürümünde Ayarlar → Agents → Claude Code → "Show plan limits"i aç, bir Claude oturumu başlat ve `docs/manual-tests.md` PL-1…PL-8 adımlarını izle. | Program gerçek Claude'da hiç çalışmadı. Limitler yalnızca Pro/Max'te ve ilk API yanıtından sonra geliyor. | Sürüm öncesi | Hayır |
| 2 | Kendi status line'ın varsa, açtıktan sonra Claude'un alt satırında hâlâ kendi çıktını gördüğünü kontrol et. Kapatınca eski ayarın geri gelmeli. | Zincirleme ve geri alma gerçek ayar dosyasında denenmedi. | Sürüm öncesi | Hayır |

### Sonraki oturum için not
Tüm değişiklikler commit'lenmemiş halde working tree'de, aynı sürümün diğer UI işleriyle birlikte duruyor. Ayrıca "Working takılması" teşhisi için `apps/desktop/src-tauri/src/agents/mod.rs`'ye bir log satırı eklendi (`background_tasks=`). Kanıt toplandıktan sonra asıl düzeltme yapılacak.
