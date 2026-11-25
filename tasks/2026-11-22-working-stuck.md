# Bitmiş turda "Working"de takılı kalan Claude oturumu

**Durum:** TAMAMLANDI
**Tarih:** 2026-11-22 (son güncelleme: 2026-11-22)
**Etkilenen yer:** `apps/desktop/src-tauri/src/agents/mod.rs` (masaüstü durum makinesi), muhtemelen `hub/Hub.Core/Adapters/ClaudeCodeAdapter.cs` ve `hub/Hub.Core/Sessions` (hub tarafı aynı kural). SAP'a yazma yok.

## A. BRIEF (işe başlamadan önce)

### Özet
Arka planda alt ajan çalıştırmış bir Claude Code oturumu, alt ajan bittikten sonra da her tur sonunda Kotilo'da "Working" görünmeye devam ediyor (gözlem: 12 dakika, sonra 43 dakika). Amaç önce Claude'un tur sonu olayında hangi görevi listelediğini kanıtla görmek, sonra bitmiş görevleri saymayan bir düzeltme yapmak.

### Arka plan
- **Kural (D-060, D-071):** Claude Code'un tur sonu olayı (`Stop`) boş olmayan bir `background_tasks` listesi taşıyorsa Kotilo oturumu "Working" tutar. Liste boşalınca ya da Claude'un `idle_prompt` bildirimi gelince oturum biter (`shell` görevi varsa `idle_prompt` de bitirmez).
- **Belge (code.claude.com/docs/en/hooks.md, 2026-11-22):** Liste "sürmekte olan" görevler için tanımlı. Her öğede `id`, `type`, `status`, `description`, türe göre `agent_type`, `command`, `name` var. `status` değerleri sayılmamış, örnekte yalnızca `running` var. Bitmiş görevlerin listede kalıp kalmadığı belgelenmemiş. `idle_prompt` yaklaşık 60 sn sonra ve yalnızca arka planda ajan çalışmıyorsa gönderiliyor.
- **Gözlem (masaüstü logu, 2026-11-22):** Bu oturumda (`3e52353b…`, panel `e832949c`) alt ajan çalıştığı 15:03'ten beri her `Stop` "Working → Working". `idle_prompt` 15:30 ve 16:01'de geldi ve oturumu bitirdi. Belgeye göre bu, Claude'un o anlarda çalışan arka plan ajanı görmediği anlamına geliyor. Buna rağmen tur sonu listesi boş değildi.
- **Hipotez:** Listede bitmiş, `status` değeri `running` olmayan bir alt ajan kalıyor (devam ettirilebilir olduğu için). Kotilo `status` alanına bakmıyor.

### Kapsam / Kapsam dışı
**Kapsam:** Kanıt toplamak (etiket, tür ve durum), masaüstü ve hub durum makinelerini bitmiş görevleri saymayacak şekilde düzeltmek, fixture'lı testler, DECISIONS kaydı.
**Kapsam dışı:** Claude Code'un kendi davranışını değiştirmek. Diğer ajanlar.

### Plan
- [x] 1. Teşhis log satırı (masaüstü, dev sürümü): `background_tasks=[tür status=… {alan adları}]`, açıklama metni yok. Birim testi ve clippy geçti.
- [x] 2. Kanıt: kurulu Kotilo'nun hub'ından bu oturumun tur sonu etiketlerini okumak (arka plan izleyicisi). Sonuç: Artifact canlı güncelleme aboneliği. Tür ve durum değeri dev sürümünde henüz görülmedi.
- [x] 3. Düzeltme: iş türü izin listesi (`shell`, `subagent`, `workflow`, `teammate`, `cloud session`), masaüstünde ve hub'da aynı kural.
- [x] 4. Testler: yeni fixture `stop_watchers_only.json`, hub ve Rust birim testleri güncellendi ve eklendi.
- [x] 5. `docs/DECISIONS.md` D-079.

### Riskler ve varsayımlar
- `status` değerleri belgelenmemiş. Bilinmeyen bir değeri "bitmiş" saymak, gerçekten çalışan bir görevi erken bitmiş gösterebilir. Bu yüzden kural kanıt görülmeden yazılmayacak.
- Arka plan izleyicisinin kendisi de bir `shell` görevi olarak listede görünecek. Kanıtı okurken bu ayıklanmalı.

### ⚠ Senden beklenenler (başlamadan önce)
| # | Karar / eylem | Neden gerekli | İşi durduruyor mu? (Evet/Hayır) | Cevap |
|---|---|---|---|---|
| 1 | Düzeltme kuralı: "Working"i yalnızca `shell`, `subagent`, `workflow`, `teammate`, `cloud session` türleri tutsun, diğerleri (izleme, abonelik, `monitor`, `MCP task`, bilinmeyen) tutmasın. Onaylıyor musun? | D-071'deki davranışı değiştiriyor: uzun süren bir `monitor` artık oturumu "Working" tutmayacak. | Evet | 2026-11-22: Onaylandı ("önerinle devam"). |

### Kararlar
- 2026-11-22: Kullanıcı önce kanıt toplanmasını seçti (seçenek 1).
- 2026-11-22: Kullanıcı görev dosyası açılmasını istedi. Sorun 43 dakikalık "Working" ile hâlâ sürüyor.
- 2026-11-22 17:09: Kanıt (kurulu hub, `GET /v1/sessions`, tur sonu etiketleri): `["live updates for artifact https://claude.ai/artifact/NWwz6Tb…", "<izleyici kabuğu>"]`. Takılan görev alt ajan değil. Claude Code'un Artifact aracı yayından sonra oturum boyunca açık kalan bir "canlı güncelleme" aboneliği açıyor ve bunu her `Stop`'ta listeliyor. Bu da 13:25'teki yayından beri oturumu "Working" tutuyor. Hipotez yanlıştı. Türü `shell` değil (yoksa `idle_prompt` bitirmezdi), Claude'a göre ajan da değil (yoksa `idle_prompt` hiç gelmezdi). Tam tür değeri henüz görülmedi (dev sürümü log satırı gerekli).
- 2026-11-22: Önerilen düzeltme: "Working"i yalnızca gerçek iş olan görev türleri tutsun (izin listesi: `shell`, `subagent`, `workflow`, `teammate`, `cloud session`). Diğer türler (izleme ve abonelikler, `monitor`, `MCP task`, bilinmeyenler) turu açık tutmasın. Kullanıcı onayı bekleniyor.

## B. RAPOR (iş bittikten sonra)
### Sonuç
Kök neden bulundu ve düzeltildi. Claude Code'un oturum boyunca açık tuttuğu bir izleme aboneliği, tur sonunda arka plan işi gibi sayılıyordu. Artık oturumu yalnızca gerçek iş türleri "Working" tutuyor.

### Yapılanlar
- **Teşhis log satırı (masaüstü):** Tur sonu listesindeki her görevin yalnızca türü, durumu ve alan adları yazılıyor. Açıklama metni yazılmıyor.
- **Kanıt:** Kurulu hub'dan okunan tur sonu etiketi `live updates for artifact https://claude.ai/artifact/NWwz6Tb…` çıktı. Bu, Artifact aracının mockup yayınından sonra açtığı canlı güncelleme aboneliği. Alt ajan hipotezi yanlıştı.
- **Düzeltme:** Masaüstünde `is_work_task` + `WORK_TASK_TYPES` (`apps/desktop/src-tauri/src/agents/mod.rs`), hub'da `IsWorkTask` + `WorkTaskTypes` (`hub/Hub.Core/Adapters/ClaudeCodeAdapter.cs`). `Stop` ve `SubagentStop` aynı listeyi kullanıyor.
- **Testler:** Eski test verilerindeki belgelenmemiş türler (`agent`, `bash`) belgelenmiş türlerle (`subagent`, `shell`) değiştirildi.
- **Belgeler:** `docs/DECISIONS.md` D-079.

### Nasıl doğrulandı
- **Masaüstü:** `cargo test -p agenthub --lib agents::` sonucu 85 testin 85'i geçti (yeni: `only_work_tasks_keep_a_finished_turn_working`, `background_task_shape_keeps_only_type_status_and_key_names`). `cargo clippy -p agenthub --all-targets -D warnings` temiz.
- **Hub:** `dotnet build` 0 uyarı, 0 hata. `dotnet test` sonucu Core 746, Service 94, Infrastructure 265, hepsi geçti (yeni: `A_stop_listing_only_watchers_finishes_the_turn`).
- **Doğrulanmayan:**
  - Abonelik görevinin tam `type` değeri yakalanmadı, yalnızca etiketi yakalandı. Kural izin listesi olduğu için sonucu değiştirmiyor, ama dev sürümündeki log satırıyla görülebilir.
  - Düzeltme gerçek bir Claude oturumunda denenmedi. Kurulu Kotilo 0.9.0'da eski kural çalışıyor, bu oturum o yüzden hâlâ "Working" görünebilir.

### Değişen nesneler / dosyalar
- `apps/desktop/src-tauri/src/agents/mod.rs` (log satırı, izin listesi, testler).
- `hub/Hub.Core/Adapters/ClaudeCodeAdapter.cs`.
- `hub/tests/Hub.Core.Tests/Sessions/BackgroundTasksTests.cs`, `hub/tests/Hub.Core.Tests/Fixtures/hooks/stop_watchers_only.json` (yeni).
- `docs/DECISIONS.md`.

### Yapılmayanlar ve açık kalanlar
- **İş türü olmayan görevler için etiket:** İzleme ya da abonelik türündeki görevler için ayrı ve sessiz bir "izleniyor" etiketi gösterilmiyor. Gerek görülmedi.
- **Yeni iş türleri:** Claude yeni bir iş türü eklerse listeye eklenene kadar o tür "bitti" görünecek. Bu bilinçli bir tercih (D-079).

### ⚠ Senden beklenenler (şimdi)
| # | Eylem | Neden | Aciliyet | İşi durduruyor mu? (Evet/Hayır) |
|---|---|---|---|---|
| 1 | Dev sürümüyle (ya da yeni sürüm kurulunca) bir Claude oturumunda Artifact ya da Monitor kullanıp tur bitince oturumun "Done" olduğunu gör. | Düzeltme gerçek bir oturumda denenmedi. | Sürüm öncesi | Hayır |

### Sonraki oturum için not
Değişiklikler commit'lenmemiş halde, bu sürümün diğer işleriyle birlikte working tree'de duruyor. Dev log'da `background_tasks=` satırı, bir sonraki benzer vakada türü ve durumu gösterecek.
