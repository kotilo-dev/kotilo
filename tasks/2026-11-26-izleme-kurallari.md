# İzleme kuralları (watch rules)

**Durum:** TAMAMLANDI
**Tarih:** 2026-11-26 (son güncelleme: 2026-11-26)
**Etkilenen yer:** `hub/` (Hub.Core, Hub.Service, testler), `apps/desktop/src` (izin kartı, zaman çizelgesi, Ayarlar), `schema/`, `docs/`. SAP'a yazma yok.

## A. BRIEF

### Özet
Ajanın riskli bir işlem yapmak üzere olduğunu fark edip kullanıcıyı uyaran, ama **hiçbir zaman engellemeyen** bir kural sistemi eklenecek. Örnekler: `.env` okumak, `git push --force`, `rm -rf`, prod adresine istek. Kurallar hub'da (arka plan servisi) değerlendirilir. Eşleşme olunca izin kartında belirgin bir etiket çıkar, zaman çizelgesine bir işaret düşer ve bildirim gelir.

### Arka plan
- **Hook:** Ajanın her olayda çağırdığı küçük Kotilo programı (`crates/hook`). Olayı hub'a gönderir, her zaman 0 koduyla çıkar ve hiçbir şey yazdırmaz. Bu davranış korunacak; kurallar hook'a gecikme eklemez, çünkü değerlendirme olay hub'a ulaştıktan sonra yapılır.
- **Hangi ajan ne gönderiyor:**
  - Araç çağrısından **önce** olay gönderenler: Claude Code, Codex, Droid ve Qwen (`PreToolUse`), Gemini (`BeforeTool`), OpenCode (`session.tool.called`).
  - Yalnızca **sonra** gönderenler: Cursor ve Copilot. Bu iki ajanda uyarı iş yapıldıktan sonra gelir.
- **Hub'a ulaşan alanlar:** Araç adı, komut, dosya yolu ve yol listesi, ayrıca `ToolDetail` alanında desen, URL veya sorgu. Hook bunları en fazla 4000 karaktere kırpar. Bu alanlar yalnızca bellekte tutulur (AGENTS.md kural 5).
- **Bugünkü risk etiketi:** `hub/Hub.Core/Sessions/PermissionPrompt.cs` içindeki `PermissionRiskClassifier`, yalnızca izin isteğinde komuta bakar ve sabit 6 değerden birini koyar. Kullanıcı bu sınıflandırmayı değiştiremez. Bu sınıflandırma olduğu gibi kalıyor; izleme kuralları onun yanına ek bir bilgi olarak geliyor.
- **Bildirim akışı:**
  - Hub bir `RuleId` üretir.
  - `NotificationFeed` bunu başlığa ve önem derecesine çevirir.
  - `NotificationGate` sessiz saatleri ve "rahatsız etme" durumunu uygular.
  - Bildirim WebSocket üzerinden masaüstüne gider ve masaüstü Windows bildirimini gösterir.
- **D-015:** Bekleyen izin ayrıntıları yalnızca bellekte tutulur. **D-036:** Zaman çizelgesi de yalnızca bellekte tutulur.

### Kararlar (kullanıcıyla, 2026-11-26)
| Soru | Cevap |
|---|---|
| Kurallar hangi olaylara bakacak? | Her araç çağrısına; izin istekleriyle sınırlı değil. |
| Kurallar nerede tanımlanacak? | Ayarlar'da (genel kurallar) ve isteğe bağlı olarak projedeki `.kotilo/watch.json` dosyasında. |
| Hazır kural seti açık mı gelecek? | Evet, açık gelecek. Her kural tek tek kapatılabilecek, tüm özellik tek anahtarla kapanacak. |

### Tasarım
(Fable'ın kod üzerinden eleştirisinden sonra revize edildi; değişenler "Kararlar"da.)

**Kural:** `id`, `name`, `enabled`, `notify` (false ise yalnızca etiket/işaret, bildirim yok) ve en az bir eşleşme alanı. Bir kuraldaki alanların hepsi tutmalı; bir alandaki listenin herhangi bir öğesi yeterli.

| Alan | Neye bakar | Örnek |
|---|---|---|
| `tools` | Araç adı (büyük-küçük harf duyarsız) | `["Read","Bash"]` |
| `command` | Komutta regex; `RegexOptions.NonBacktracking` (geri izleme yok, felaket yavaşlama olmaz) + 50 ms zaman aşımı; zaman aşımına uğrayan kural o oturum boyunca kapatılır | `git\s+push.*(--force\|-f)` |
| `paths` | Dosya yolu deseni (glob, mevcut `GlobPattern`); hem proje-göreli hem mutlak yola uygulanır; boş desen reddedilir | `**/.env`, `**/.env.*` |

(Alan adı alanı `hosts` çıkarıldı: komut regex'i aynı işi görüyor.)

**Hazır kurallar** (`builtin.*`, gürültü düşük tutulacak):
| Kural | Kapsam | Bildirim |
|---|---|---|
| Gizli dosya | `.env`, `.env.*` (ama `.example`/`.sample`/`.template` hariç), `*.pem`, `*.key`, `id_rsa*`/`id_ed25519*` okuma/yazma | Evet |
| Zorla push | `git push --force` / `-f` / `+refspec`; daha güvenli olan `--force-with-lease` uyarmaz | Evet |
| Geri dönüşsüz git | `git reset --hard`, `git clean -fd` | Hayır (yalnızca etiket) |
| Geniş silme | `rm -rf` / `Remove-Item -Recurse -Force` yalnızca mutlak, `~`, `..` veya `/` hedefinde (`rm -rf node_modules` uyarmaz) | Evet |
| Veritabanı silme | `DROP TABLE|DATABASE`, `TRUNCATE` | Evet |
| İndir-çalıştır | `curl|wget … \| sh|bash|iex` | Evet |

**Katmanlar:** (1) hazır kurallar; (2) Ayarlar'daki kullanıcı kuralları ve kapatılmış hazır kurallar (`AppSettings.Watch`; eski `settings.json` dosyasında alan yoksa varsayılanlar); (3) proje dosyası `.kotilo/watch.json`.

**Proje dosyası güvenliği** (depo dışarıdan gelebilir):
- Proje kuralları **proje başına onayla** etkinleşir: Ayarlar'da dosya bulunan projeler listelenir, "Bu projenin kurallarını kullan" anahtarı varsayılan kapalı. Böylece klonlanan bir depo kendiliğinden bildirim yağdıramaz.
- Proje dosyası yalnızca kural ekler; hazır veya kullanıcı kurallarını kapatamaz, `builtin.*` kimliğini kullanamaz (kimlik otomatik `project.` ön ekli, `^[a-z0-9._-]{1,64}$`).
- Sınırlar: dosya ≤ 64 KB, ≤ 50 kural, regex ≤ 500 karakter, ad ≤ 60 karakter (kontrol karakterleri temizlenir). Sembolik bağ/junction olan dosya okunmaz. Boyut okumadan önce denetlenir.
- Dosya her olayda değil, hub'ın mevcut 5 sn'lik zamanlayıcısında yeniden denetlenir.
- Bozuk dosya veya geçersiz kural atlanır, sorun Ayarlar'da gösterilir.

**Nerede ve ne zaman değerlendirilir:**
- `EventPipeline.ApplyHook` içinde, `_tracker.Apply(e)`'den **önce**; sonuç olaya taşınır (`e with { Watch = … }`, mevcut `e.Risk` gibi). Böylece izin kartı ve zaman çizelgesi aynı karede doğru gelir. (`HookObserved` aboneliği geç kalırdı: oturum karesi zaten yayınlanmış olur.)
- Değerlendirme yalnızca zaman çizelgesinde yeni bir araç satırı açan olayda yapılır (ön olay; ön olayı olmayan Cursor/Copilot'ta son olay). Aynı çağrı iki kez değerlendirilmez; `ToolUseId` olmayan ajanlar da kapsanır.
- Claude'un izin kartı çoğu zaman araç bilgisi olmayan bir `Notification` ile oluşur: son eşleşme `SessionInfo` üzerinde (bellekte) tutulur ve kart oluşurken oradan kopyalanır.
- Kuyruktan yeniden oynatılan (hub kapalıyken biriken) olaylarda bildirim gönderilmez.

**Eşleşince:**
1. **İzin kartı:** "Kural: <ad>" etiketi, mevcut risk etiketinden belirgin. `PermissionPrompt`'a init özelliği (konumsal parametre değil; mevcut eşitlik testleri bozulmasın) ve `PendingPermissionDto`'ya alan.
2. **Zaman çizelgesi:** satırda uyarı işareti ve kural adı (`ActivityEntry.WatchRule`, yalnızca bellek).
3. **Bildirim:**
   - Çağrı izin istiyorsa ayrı bildirim yok; mevcut "izin bekliyor" bildiriminin metnine kural adı eklenir (çift bildirim olmaz).
   - İzin istemeden çalışan çağrıda yeni `watch.matched` (önem "attention"), başlık mevcut biçimde (`<proje>: <durum>`, DESIGN_SYSTEM §7.11), metin "kural adı · araç adı". Komut bildirime girmez.
   - Aynı oturum ve kural için 5 dakikada en fazla bir bildirim; sayaç bellekte (`notification_log` zaman penceresi desteklemiyor ve diske yazmaya gerek yok).
   - Sessiz saatler ve "rahatsız etme" otomatik uygulanır.

**Diskte ne kalır:** Hiçbir eşleşme kaydı diske yazılmaz. Log satırında yalnızca kural kimliği olur; `RegexMatchTimeoutException` (girdi olarak komutu taşır) değerlendirici içinde yakalanır, loga gitmez. "Komutu dene" uç noktası istek gövdesini loglamaz (testle doğrulanır).

**Ayarlar → Bildirimler → "İzleme kuralları" bloğu:** tümünü aç/kapa; hazır kurallar ve her biri için anahtar; kullanıcı kuralları için ekle/düzenle/sil (ad, araçlar, komut regex'i, yol deseni, bildirim gönder); regex'in yazarken denetlenmesi; "Bir komutu dene" kutusu (hub'daki gerçek değerlendiriciyle); `.kotilo/watch.json` bulunan projeler, her biri için onay anahtarı, kural sayısı ve hata satırı.

**Hub ↔ masaüstü sözleşmesi** (iki taraf paralel yazılabilsin diye baştan sabitlendi; JSON camelCase):
```text
Settings (GET/PUT existing hub settings):  watch: {
  enabled: bool = true,
  disabledBuiltins: string[] = [],          // builtin ids switched off
  notifyOffBuiltins: string[] = [],         // builtin ids whose notify the user turned off
  rules: WatchRule[] = [],                  // user rules, ids "user.<slug>"
  trustedProjects: string[] = [] }          // project roots whose .kotilo/watch.json is used
WatchRule: { id, name, enabled, notify, tools?: string[], command?: string, paths?: string[] }
WatchHit:  { id, name }                     // builtin name = English fallback; desktop shows i18n "watch.builtin.<id-after-prefix>" when it has one
PendingPermissionDto.watch?: WatchHit       // optional; absent = no badge
ActivityEntry.watch?: WatchHit              // optional
Notification ruleId "watch.matched", severity "attention", message "<rule name> · <tool>"
GET  /v1/watch -> { builtins: WatchRule[] (effective enabled/notify), user: WatchRule[],
                    projects: [{ root, trusted, ruleCount, problems: [{ line?, message }] }],
                    problems: [{ ruleId, message }] }
POST /v1/watch/test { tool?, command?, path?, root? } -> { matches: WatchHit[] }   // body never logged
Builtin ids: builtin.secret-file, builtin.force-push, builtin.git-discard, builtin.wide-delete,
             builtin.db-drop, builtin.pipe-to-shell
```

### Kapsam / Kapsam dışı
**Kapsam:**
- Hub'da kural modeli, değerlendirici ve hazır kurallar;
- ayarlar ve proje dosyası;
- olay hattına bağlama;
- bildirim, izin kartı etiketi ve zaman çizelgesi işareti;
- Ayarlar arayüzü;
- İngilizce ve Türkçe metinler;
- testler, karar kaydı (D-083), kullanıcı kılavuzu ve elle test listesi.

**Kapsam dışı:**
- Engelleme veya hook'un çıkış kodunu değiştirme (2026-11-09 kararı).
- Komut içeriğini saklamak veya kural eşleşmelerinin kalıcı geçmişi (kural 5).
- Mevcut `PermissionRiskClassifier` sınıflandırmasının değiştirilmesi.
- Telefon bildirimleri (ntfy, ayrı iş).

### Plan
- [x] 1. **Hub.Core çekirdeği:** `Hub.Core/Watch/` altında `WatchRule`, `WatchRuleSet` (katmanları birleştirme ve doğrulama) ve `WatchEvaluator` (olayı kurallarla eşleme, regex zaman aşımı) yazılır. Hazır kurallar eklenir. Her hazır kural için eşleşen ve eşleşmeyen örneklerle testler yazılır.
- [x] 2. **Hub.Service:**
  - `AppSettings.Watch` alanı eklenir.
  - `.kotilo/watch.json` okuyucu yazılır; dosyanın değiştirilme zamanına göre önbelleğe alır.
  - `EventPipeline.ApplyHook` içinde `_tracker.Apply` öncesinde değerlendirilir; yalnızca yeni zaman çizelgesi satırı açan olayda; yeniden oynatmada bildirim yok.
  - `PermissionPrompt.WatchRule` ve `ActivityEntry.WatchRule` doldurulur.
  - `watch.matched` bildirimi ve `NotificationFeed` eşlemesi (İngilizce/Türkçe) eklenir.
  - Uç noktalar: `GET /v1/watch` (etkin kurallar, proje dosyaları ve sorunlar) ve `POST /v1/watch/test` (komut dene).
  - Ek testler: bildirimden oluşan Claude kartı, yeniden oynatmada sessizlik, `ToolUseId` olmayan ve yalnızca son olay gönderen ajanlar, zaman aşımının kuralı kapatması, `Watch` alanı olmayan eski ayar dosyası, proje kuralının `builtin.*` kimliğini alamaması, onaysız projenin kurallarının uygulanmaması.
  - Sözleşme ve API testleri yazılır. Bir test, komut metninin hiçbir log veya veritabanı satırına girmediğini doğrular.
- [x] 3. **Masaüstü:**
  - `hubTypes.ts` tipleri güncellenir.
  - İzin kartına "Kural" etiketi, zaman çizelgesine işaret eklenir.
  - Ayarlar → Bildirimler'e "İzleme kuralları" bloğu eklenir; arama dizini ve metinler (İngilizce/Türkçe) de güncellenir.
  - vitest testleri ve Playwright ekran görüntüleri (kart, zaman çizelgesi, Ayarlar bloğu; koyu ve açık tema) alınır.
- [x] 4. **Belgeler:**
  - `docs/DECISIONS.md` içine D-083 eklenir.
  - Kullanıcı kılavuzuna (İngilizce/Türkçe) "İzleme kuralları" bölümü ve `.kotilo/watch.json` örneği eklenir.
  - `docs/manual-tests.md` içine elle testler WR-1…WR-8 eklenir.
  - `schema/watch-rules.v1.json` yazılır.
- [x] 5. **İnceleme ve doğrulama:**
  - Fable son diff'i eleştirel olarak inceler.
  - `dotnet test`, `cargo test`, vitest, ilgili e2e testleri ve UI derlemesi çalıştırılır.
  - Rapor yazılır.

İş bölümü: Plan ve son karar Opus'ta. 1–2. adımı ve 3. adımı Sonnet uygular; 3. adım, 2. adımdaki DTO'lar netleşince başlar. Fable plana önceden ve son diff'e sonradan bakar.

### Riskler ve varsayımlar
- **Yanlış alarm:** Hazır regex'ler dar tutuldu (`rm -rf` yalnızca mutlak, `~`, `..` veya `/` hedefinde; `.env.example` hariç). Gürültülü bulunan kural tek tek kapatılabilir veya `notify` kapatılıp yalnızca etiket bırakılabilir. Bildirimdeki 5 dakikalık sınır da gürültüyü azaltır.
- **Kötü regex:** `NonBacktracking` ve 50 ms zaman aşımı; zaman aşımına uğrayan kural o oturum boyunca kapatılır ve bir kez loglanır (yalnızca kural kimliği).
- **Uyarının geç gelmesi:** "Önce" olayında bile uyarı, araç çalışmaya başlarken gelir; Kotilo engellemediği için bu kaçınılmaz. Cursor ve Copilot'ta uyarı her zaman iş bittikten sonra gelir. Bu durum kılavuzda açıkça yazılacak.
- **Varsayım:** Hub, oturumun proje kökünü biliyor. Kök bilinmeyen oturumlarda proje dosyası okunmaz; yalnızca genel kurallar uygulanır.
- **Eski hub ile yeni masaüstü:** Yeni alanlar isteğe bağlı olacak; alan yoksa etiket ve işaret görünmez.

### ⚠ Senden beklenenler (başlamadan önce)
| # | Karar / eylem | Neden gerekli | İşi durduruyor mu? (Evet/Hayır) | Cevap |
|---|---|---|---|---|
| 1 | Planı onaylamak | Yeni bir özellik ve hub ile masaüstü arasındaki sözleşme değişiyor | Evet | 2026-11-26 onaylandı |
| 2 | Bitince `tauri dev` ile gerçek bir ajanda WR-1…WR-8 elle testleri | Gerçek ajan ve gerçek bildirim testle görülemiyor (AGENTS.md kural 6) | Hayır | |

### Kararlar
- 2026-11-26: Üç tasarım sorusu soruldu. Kullanıcının seçimleri: her araç çağrısı; Ayarlar ve proje dosyası; hazır kural seti açık gelsin.
- 2026-11-26: Plan onaylandı.
- 2026-11-26: Fable planı kodla karşılaştırdı; şu düzeltmeler plana işlendi: değerlendirme `HookObserved` yerine `_tracker.Apply` öncesine alındı (aksi halde kart ve çizelge bir kare geç kalırdı); Claude kartı için son eşleşme oturumda tutuluyor; yeniden oynatılan olaylar bildirim üretmiyor; tekilleştirme zaman çizelgesi satırına bağlandı; bildirim sınırı bellekte; izin isteyen çağrıda çift bildirim yok; regex `NonBacktracking` + sınırlar; proje dosyası proje başına onayla ve sınırlarla; `hosts` alanı çıkarıldı; hazır kurallar daraltıldı (`.env.example`, `rm -rf node_modules` uyarmaz) ve `notify` bayrağı eklendi.

### Doğrulama planı
- `dotnet test hub/AgentHub.sln`. Yeni testler:
  - değerlendirici;
  - katman birleştirme ve proje dosyası doğrulaması;
  - aynı çağrının iki kez değerlendirilmemesi;
  - bildirim sınırı;
  - komut metninin kalıcı yerlere girmediği.
- `npm --prefix apps/desktop test` ve `npm --prefix apps/desktop run build`.
- Playwright: yeni ekran görüntülerine bakılır (izin kartı ile kural etiketi, zaman çizelgesi işareti, Ayarlar bloğu).
- `cargo test --workspace` ve clippy. Hook değişmiyor, yine de çalıştırılır.
- Uzun komutlar arka planda çalıştırılır.

## B. RAPOR (iş bittikten sonra)
### Sonuç
İzleme kuralları çalışıyor. Hub her araç çağrısını hazır kurallar, senin kuralların ve onayladığın projelerin `.kotilo/watch.json` kurallarıyla karşılaştırıyor. Eşleşme izin kartında, zaman akışında ve gerektiğinde bir bildirimde görünüyor. Hiçbir çağrı engellenmiyor ve hiçbir komut metni diske yazılmıyor.

### Yapılanlar
- **Hub çekirdeği** (`hub/Hub.Core/Watch/`):
  - kural modeli, sınırlar ve doğrulama;
  - hazır kurallar: gizli dosya, zorla push, geri dönüşsüz git, geniş silme, veritabanı silme, indir-çalıştır;
  - regex derleyici: `NonBacktracking`, 50 ms zaman aşımı, zaman aşımına uğrayan kural o oturumda kapanır;
  - proje dosyası ayrıştırıcısı ve değerlendirme motoru.
- **Olay hattı:**
  - Değerlendirme, oturum durumu güncellenmeden önce ve yalnızca zaman akışında yeni satır açan olayda yapılır. Regex kilit dışında çalışır.
  - Eşleşme olayın üzerinde taşınır. İzin kartı, olayın bağlandığı satırın eşleşmesini alır; böylece paralel çağrılarda başka bir çağrının etiketi karta düşmez.
- **Bildirim:**
  - `watch.matched` bildirimi 3 saniyelik bekleme ve oturum+kural başına 5 dakika sınırıyla gönderilir; sayaç bellekte tutulur.
  - İzin isteyen çağrıda ayrı bildirim yok; kural adı izin bildirimine eklenir. İzin hızlı verilse bile çift bildirim olmaz.
  - Yeniden oynatılan olaylar bildirim üretmez.
- **Ayarlar ve API:**
  - Hub ayarlarına `watch` alanı eklendi. Eski ayar dosyası varsayılanlarla açılır.
  - Doğrulama: alan bazında hata; güvenilen proje yolu mutlak olmalı ve `..` içermemeli.
  - Uç noktalar: `GET /v1/watch` ve `POST /v1/watch/test`.
  - `WatchService` proje dosyalarını kendi 5 saniyelik zamanlayıcısıyla, olay kuyruğunu bekletmeden yeniler. Dosya en fazla 64 KB olabilir, sembolik bağ okunmaz.
- **Masaüstü:**
  - İzin kartında sarı "Kural: <ad>" şeridi.
  - Zaman akışı satırında uyarı işareti ve kural adı.
  - Ayarlar → Bildirimler → "İzleme kuralları" bloğu: ana anahtar; hazır kurallar için kullanım ve bildirim anahtarları; kendi kurallarını ekleme, düzenleme ve silme; "Bir komutu dene"; proje listesi ve proje başına onay.
  - İngilizce ve Türkçe metinler.
- **Belgeler:**
  - D-083 karar kaydı;
  - kullanıcı kılavuzunda (İngilizce/Türkçe) "Watch rules / İzleme kuralları" bölümü;
  - elle testler WR-1…WR-8 (`docs/manual-tests.md`);
  - `schema/watch-rules.v1.json`.
- **İnceleme sonrası düzeltmeler (Fable):**
  - PowerShell'de `-ErrorAction` gibi uzun parametreler ve `> /dev/null` yönlendirmeleri artık "geniş silme" sayılmıyor.
  - Kartta yanlış kural etiketi sorunu giderildi (oturumda "son eşleşme" tutulmuyor).
  - Çift bildirim sorunu giderildi.
  - Komutlarda `.key`/`.pem` yalnızca yol biçimindeyse sayılıyor; `jq '.key'` artık uyarmıyor.
  - `git.exe push -f` ve `/usr/bin/git push -f` biçimleri yakalanıyor.
  - Coreutils `truncate log.txt` komutu artık uyarmıyor.
  - Proje dosyasında yanlış tipteki bir alan kuralı genişletmek yerine reddediyor.

### Nasıl doğrulandı
| Kontrol | Sonuç |
|---|---|
| `dotnet test hub/AgentHub.sln` | Core 895, Infrastructure 265, Service 113: hepsi geçti. Yeni testler: hazır kurallar için eşleşen ve eşleşmeyen örnekler; katmanlar; proje dosyası sınırları ve onay; yeniden oynatmada sessizlik; çift bildirim; 5 dakika sınırı; paralel çağrı etiketi; kilit dışı değerlendirme. Kural 5 testi, eşleşen komuttaki işaret metninin hiçbir log satırında ve `hub.db*` dosyasında geçmediğini doğruluyor. |
| `cargo clippy --workspace --all-targets -D warnings` | Temiz (hook değişmedi). |
| vitest | 1165 testten 1164'ü geçti. Yardım penceresi testi tam takımda 5 saniyede zaman aşımına uğradı; tek başına 13/13 geçti. Yük kaynaklı kararsızlık. |
| UI derlemesi | Başarılı. |
| e2e (Playwright, tam takım) | 172 testten 171'i geçti. Düşen, bilinen kararsız tepsi menüsü testi; tek başına geçti. Yeni `watch.spec.ts`: 13/13. |
| Ekran görüntüleri | `watch-permission-*`, `watch-timeline-*`, `settings-watch-*` (koyu/açık × İngilizce/Türkçe), `apps/desktop/test-results/screens/` altında. Kart, zaman akışı ve Ayarlar bloğuna baktım; düzgün. |
| **Doğrulanamayan** | Gerçek ajanla uçtan uca akış: gerçek Windows bildirimi, Claude'un gerçek olay sırası, Cursor/Copilot'un sonradan gelen olayı. Bunlar WR-1…WR-8 elle testlerinde. |

### Değişen nesneler / dosyalar
- **Hub, yeni dosyalar:**
  - `hub/Hub.Core/Watch/*`
  - `hub/Hub.Service/Hosting/WatchService.cs`
  - `hub/Hub.Service/Api/WatchEndpoints.cs`
  - `hub/tests/Hub.Core.Tests/Watch/*`
  - `hub/tests/Hub.Service.Tests/Watch{Api,Pipeline,Service}Tests.cs`
- **Hub, değişen dosyalar:** `ActivityTracker`, `HookEvent`, `PermissionPrompt`, `SessionInfo`, `SessionStateMachine`, `RuleEngine`, `RuleIds`, `ApiJson`, `NotificationFeed`, `SettingsEndpoints`, `AppHost`, `AppSettings`, `EventPipeline`, `Hub.Core.csproj`.
- **Masaüstü, yeni dosyalar:**
  - `features/settings/WatchRulesSettings.tsx`
  - `features/settings/watchRules.ts`
  - `app/i18n/watch.{en,tr}.ts`
  - `e2e/watch.spec.ts`
  - `src/e2e/watchFixtures.ts`
  - testler
- **Masaüstü, değişen dosyalar:** `PermissionCard.tsx`, `TimelineRail.tsx`, `HubSections.tsx`, `hubSettings.ts`, `settingsSearch.ts`, `hubTypes.ts`, `en.ts`, `tr.ts`, e2e fixture'ları.
- **Belgeler:** `docs/DECISIONS.md` (D-083), `docs/manual-tests.md`, `apps/desktop/docs/{,tr/}user-guide.md`, `schema/watch-rules.v1.json`.

### Yapılmayanlar ve açık kalanlar
| Madde | Neden |
|---|---|
| Proje dosyası hata mesajları yalnızca İngilizce | Mesajları hub üretiyor; Türkçe ekranda İngilizce görünüyor. Küçük bir eksik; istenirse hub tarafında yerelleştirilir. |
| Proje listesi yalnızca açık oturumların ve onaylanmış projelerin köklerini gösteriyor | Hub yalnızca bunları biliyor. Hiç ajan açılmamış bir projenin dosyası listede görünmez. |
| "Bir komutu dene" kaydedilmiş kurallarla çalışıyor | Kaydedilmemiş taslak test edilemiyor. Arayüz bunu söylüyor. |
| Zaman aşımı testi iç bir giriş noktası kullanıyor | `NonBacktracking` regex güvenilir biçimde zaman aşımına uğratılamıyor. |
| Kararsız iki test (yardım penceresi, tepsi menüsü) | Tam takım yükünde ara sıra düşüyorlar, tek başlarına geçiyorlar. Bu işle ilgisizler. |

### ⚠ Senden beklenenler (şimdi)
| # | Eylem | Neden | Aciliyet | İşi durduruyor mu? (Evet/Hayır) |
|---|---|---|---|---|
| 1 | Uygulama kapalıyken `dotnet build hub/AgentHub.sln`, ardından `tauri dev`; WR-1…WR-8 elle testleri (`docs/manual-tests.md`) | `tauri dev` hub'ı yeniden derlemiyor. Gerçek ajan ve gerçek bildirim testle görülemiyor (AGENTS.md kural 6). | Commit'ten önce | Hayır |
| 2 | Commit kararı | Commit yalnızca sen isteyince yapılır | Uygun olduğunda | Hayır |

### Sonraki oturum için not
- Hiçbir şey commit edilmedi. `tasks/2026-11-26-gorsel-cila.md` içindeki küçük not değişikliği de commit bekliyor.
- Bir sonraki karar numarası D-084.
- Değerlendirme `EventPipeline.ApplyHook` içinde `ActivityTracker.ObserveWatched` üzerinden yapılıyor.
