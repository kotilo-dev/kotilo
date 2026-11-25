# Workspace grupları, durum gruplu ajan listesi ve arayüz ölçeği

**Durum:** TAMAMLANDI
**Tarih:** 2026-11-25 (son güncelleme: 2026-11-25)
**Etkilenen yer:** `apps/desktop` (Rust `workspace/`, `settings/`, capabilities; React `features/workspaces`, `features/agents`, `features/settings`, terminal, viewer), `docs/`. SAP'a yazma yok.
Dört bölüm tek görev dosyasında tutuluyor (planda iki dosya yazıyordu; hepsi aynı sürüm listesine girdiği için birleştirildi). Dizin: `tasks/todo.md`; sürüm listesi: `tasks/2026-11-22-ui-surumu.md`.

## A. BRIEF

### Özet
1. Workspaces sekmesinde workspace'ler kullanıcının tanımladığı gruplar altında görünecek (ör. "İş projeleri", "Kişisel", "Oyunlar").
2. Alttaki Ajanlar panelinde ajanlar durum başlıkları altında gruplanacak. Sıra: Bekleyen › Çalışan › Biten › Boşta.
3. Ayarlara bir arayüz ölçeği gelecek (%90–%200). Panelleri, menüleri ve sayfaları büyütecek, terminal ve editör ise kendi font boyutunda kalacak.
4. Ayarlara bir arayüz fontu seçimi gelecek. Terminal ve editör fontları zaten ayrı ayarlarla değiştirilebiliyor.

### Arka plan
- **Workspace verisi** Rust'ta tutuluyor. Model `src-tauri/src/workspace/model.rs` dosyasında, store `store.rs` dosyasında: her değişiklik `state.json` içindeki `"workspaces"` bölümüne yazılıyor. Komutlar `commands/workspace.rs` dosyasında. UI tarafında store `src/stores/workspaceStore.ts`; bu store durumu yalnızca `workspaces:changed` olayından alıyor. Playwright testleri için sahte IPC `src/e2e/setup.ts` dosyasında.
- **Panel düzeni** `stores/layoutStore.ts` → `"layout"` bölümünde saklanıyor. `mergeWithDefaults` her alanı tek tek ve açıkça okuyor, listede olmayan alan yüklenirken kayboluyor.
- **Ajan sıralaması** `features/agents/agentLogic.ts` içindeki `sortAgents` ve `STATE_PRIORITY` ile yapılıyor. Aynı öncelik workspace rozetinde ("en acil durum") ve Ctrl+Shift+A komutunda (`App.tsx:212`) da kullanılıyor.
- **Sağ tık menüsü** (`ContextMenu.tsx`) bir öğeye tıklanınca menüyü hep kapatıyor, alt menü desteği yok.
- **Font boyutları** `src/index.css` içinde px cinsinden token'lar (`--text-ui: 13px` …). Yükseklikler de çoğunlukla sabit px. Bu yüzden yalnızca font token'larını büyütmek satırları taşırır. Ölçekleme bütün webview'ın yakınlaştırmasıyla yapılacak. Tauri 2.12 bunu destekliyor: `getCurrentWebview().setZoom`, Rust tarafında `set_zoom`, izin adı `core:webview:allow-set-webview-zoom`.
- **Fable incelemesi (2026-11-25):** İlk taslakta altı sorun buldu ve hepsi aşağıdaki plana işlendi:
  1. Bütün grup listesini tek komutla göndermek, hızlı art arda yapılan işlemlerde değişiklik kaybına yol açıyordu.
  2. Sağ tık menüsünün yerinde değişmesi bugünkü `ContextMenu` ile çalışmıyordu.
  3. `moveWorkspace` ve klavye imleci grupları bilmiyordu.
  4. `init` ve `applyWorkspacesChanged` grupları kopyalamıyordu.
  5. Bozuk tek bir grup kaydı bütün workspace listesini silebiliyordu.
  6. Daraltma durumunu Rust'ta tutmak, her tıklamada gereksiz olay yayınlıyordu.

### Kullanıcı kararları (2026-11-25)
- Grup atama sağ tık menüsüyle yapılacak, sürükle-bırak yok.
- Ajan sırası: Bekleyen › Çalışan › Biten › Boşta.
- Başlıklar daraltılabilir olacak ve kapalı/açık durumu hatırlanacak.
- Ölçek terminali ve editörü büyütmeyecek, onlar kendi ayarlarında kalacak.
- Ölçek Ayarlar'dan ve komut paletinden değiştirilecek, klavye kısayolu olmayacak.

### Kapsam

**Bölüm 1: Workspace grupları**
1. **Model (Rust):**
   - `Workspace.group: Option<String>` (grubun id'si).
   - `WorkspacesState.groups: Vec<WorkspaceGroup { id, name }>`. Grupların sırası dizideki sırayla aynı.
   - Bütün yeni alanlarda `serde(default)` var, böylece eski `state.json` sorunsuz okunur.
   - Yüklemede, var olmayan bir gruba işaret eden `group` değeri temizlenir.
2. **Tek işlemli komutlar:** Her komut kendi başına bütün işi yapar, kaydeder ve `workspaces:changed` yayınlar. Kısmi durum oluşmaz.

   | Komut | Ne yapar |
   |---|---|
   | `workspace_group_create(name, workspaceId?)` | Grubu oluşturur, workspace verildiyse aynı adımda onu da gruba taşır. |
   | `workspace_group_rename(id, name)` | Grubun adını değiştirir. |
   | `workspace_group_remove(id)` | Grubu siler, içindeki workspace'ler grupsuz kalır. |
   | `workspace_group_move(id, up\|down)` | Grubu bir sıra yukarı ya da aşağı taşır. |
   | `workspace_set_group(workspaceId, groupId \| null)` | Workspace'i bir gruba taşır ya da gruptan çıkarır. |

   - Grup adı baştaki ve sondaki boşluklardan temizlenir. Boş ad `invalid_name` hatası verir.
   - Büyük/küçük harf farkı gözetmeden aynı adda ikinci grup `duplicate_group` hatası verir.
   - Var olmayan bir grup id'si `not_found` hatası verir.
3. **Görünüm sırası:** Rust'ta ve TypeScript'te birer saf fonksiyon olacak: `display_order` ve `groupedWorkspaces(workspaces, groups)`. Sıra şöyle: gruplar kendi sıralarıyla, en sonda "Grupsuz". Hiç grup yoksa liste bugünkü gibi başlıksız görünür. Bu sırayı kullanacak yerler:
   - Workspaces listesi,
   - hızlı geçiş listesi,
   - Mission Control'deki `WorktreesPanel`,
   - Ctrl+1…9 kısayolları (kapalı gruplar da sayılır, yoksa numaralar daraltınca kayardı),
   - Rust'ta workspace silindiğinde seçilecek sıradaki aktif workspace.
4. **UI store:** `init` ve `applyWorkspacesChanged` `groups` alanını da kopyalar. Yeni eylemler, yukarıdaki komutların karşılıkları olacak. `moveWorkspace` yalnızca aynı gruptaki komşusuyla yer değiştirir, menüdeki yukarı/aşağı öğelerinin pasif olması da grup içi ilk/son satıra göre belirlenir.
5. **Daraltma durumu:** `layout.collapsedWorkspaceGroups: string[]` alanında saklanır ve `mergeWithDefaults` içinde açıkça doğrulanır. Bu görünüm durumu olduğu için Rust'a gitmez ve olay yayınlamaz.
6. **Workspaces sekmesi:**
   - **Grup başlığı:** ok işareti, grup adı ve workspace sayısı. Grup kapalıyken içinde cevap bekleyen ajan varsa başlıkta kırmızı bir sayı görünür.
   - **Workspace'e sağ tık:** "Gruba taşı…" seçilince aynı menü yerinde grup listesine dönüşür: mevcut gruplar, "Yeni grup…" ve "Gruptan çıkar". Bunun için `ContextMenuItem`'a `keepOpen` bayrağı eklenecek ve menünün yüksekliği yeniden hesaplanacak.
   - **"Yeni grup…":** listenin üstünde satır içi bir ad kutusu açar (`InlineInput` yeniden kullanılır).
   - **Başlığa sağ tık:** yeniden adlandır, sil, yukarı/aşağı taşı.
   - **Boş alana sağ tık:** "Yeni grup…".
7. **Klavye:** İmleç yalnızca görünen satırlarda ve grup başlıklarında dolaşır.
   - Başlıktayken Enter ya da Boşluk grubu açar/kapatır, ← kapatır, → açar.
   - F2 ve Delete başlıkta grubu, satırda workspace'i hedefler.
   - Aktif workspace kapalı bir gruptaysa imleç o grubun başlığına düşer, yani gizli bir satır üzerinde işlem yapılmaz.
8. **Hızlı geçiş listesi** (Files başlığı): aynı grup başlıkları gösterilir ama yalnızca etiket olarak, daraltılamaz. Arama yazılınca başlıklar gizlenir.

**Bölüm 2: Durum gruplu ajan listesi**
9. Yeni bir `AGENT_GROUP_ORDER = blocked, working, done, idle` sırası ve gruplama fonksiyonu `groupAgents` eklenecek. Her grubun içi bugünkü gibi bekleme süresine göre sıralanır.
   - `sortAgents` ve `STATE_PRIORITY` değişmez. Böylece workspace rozeti ve Ctrl+Shift+A bugünkü gibi çalışır.
10. Başlıklar Bekleyen / Çalışan / Biten / Boşta olacak, yanlarında ajan sayısı yazacak. İçinde ajan olmayan grup gösterilmez.
    - Başlıklar daraltılabilir. Kapalı gruplar `layout.collapsedAgentGroups` alanında saklanır ve bu alan da `mergeWithDefaults` içinde açıkça doğrulanır.
    - Bekleyen grubunun başlığındaki sayı kırmızı gösterilir.

**Bölüm 3: Arayüz ölçeği**
11. **Ayar:** `appearance.uiScale` adlı yeni ayar, yüzde cinsinden bir sayı.
    - İzin verilen değerler: 90, 100, 110, 125, 150, 175, 200. Varsayılan 100.
    - Rust'taki `AppearanceSettings` alanı alır (`serde(default)`). Listede olmayan bir değer gelirse en yakın değere yuvarlanır (`validate` içinde).
12. **Uygulama:**
    - Rust, ana pencereyi oluştururken ölçeği `set_zoom` ile uygular, böylece açılışta %100 görünüp sonra zıplamaz.
    - Ayar değişince webview tarafı `getCurrentWebview().setZoom(scale)` çağırır. Bu, `themeSync`'teki kalıba benzer bir abonelikle yapılır.
    - Ana pencerenin capabilities dosyasına `core:webview:allow-set-webview-zoom` izni eklenir.
    - Yalnızca ana pencere ölçeklenir. Dikte katmanı, maskot ve asistan penceresi bu işin kapsamı dışında.
13. **Terminal ve editörün korunması:** Bu iki alanın gerçek boyutu, ölçek ne olursa olsun kullanıcının verdiği değerde kalır.
    - Ortak bir `unscaledFontSize(px, uiScale)` yardımcısı `px / ölçek` hesaplar.
    - Bu yardımcıyı kullanacak yerler: xterm (`terminalRegistry.ts:123`, `TerminalView.tsx:385`), Monaco (`TextEditor.tsx:153`) ve iki diff görünümü (`DiffView.tsx`, `ExternalChangeBanner.tsx`). Diff görünümleri bugün varsayılan font boyutunu kullanıyor, bu işle onlar da editörün font boyutunu alacak.
    - Ölçek değişince terminal yeniden sığdırılır: `TerminalView.tsx:403` içindeki karşılaştırmaya `uiScale` de eklenir.
14. **Kontroller:**
    - Ayarlar → Görünüm altında bir açılır liste.
    - Komut paletinde üç komut: "Arayüzü büyüt", "Arayüzü küçült", "Arayüz ölçeğini sıfırla". Büyüt ve küçült listede bir sonraki değere geçer.
    - Klavye kısayolu yok.

**Bölüm 4: Arayüz fontu** (kullanıcının ek isteği, 2026-11-25)
15. **Ayar:** `appearance.uiFontFamily` adlı yeni bir metin ayarı. Varsayılan değer boş; boşsa bugünkü paketli Geist fontu kullanılır. Rust `AppearanceSettings` alanı `serde(default)` ile alır.
16. **Uygulama:** Arayüzün bütün yazıları tek bir CSS değişkeninden, `--font-ui` (`index.css:29`) değişkeninden geliyor. Ayar doluysa `applyTheme` bu değişkeni şu şekilde ayarlar: `"<kullanıcının fontu>", "Geist", "Segoe UI", system-ui, sans-serif`. Böylece yazım hatalı ya da bilgisayarda kurulu olmayan bir font girilirse arayüz yine Geist'e düşer. Değişiklik yeniden başlatmadan anında uygulanır.
17. **Kontrol:** Ayarlar → Görünüm'de editör ve terminal fontlarındaki gibi bir metin kutusu (`DebouncedText`) ve "Varsayılana dön" düğmesi.
    - Arayüzdeki yol ve sayı gibi monospace yazılar `--font-code` ile Geist Mono'da kalır.
    - Editör ve terminal fontları zaten ayrı ayarlarla değişiyor, bu işe dahil değiller.

**Hepsi için:** i18n EN ve TR, `docs/DECISIONS.md` içinde D-080 (gruplar) ve D-081 (ölçek ve arayüz fontu), kullanıcı kılavuzu EN/TR, `docs/manual-tests.md` içine yeni maddeler.

### Kapsam dışı
Bu işte yapılmayacaklar:
- sürükle-bırak,
- iç içe grup,
- grup rengi ya da ikonu,
- ajanları workspace grubuna göre gruplamak,
- Files ağacında gruplama,
- yan pencerelerin (dikte katmanı, maskot, asistan) ölçeklenmesi.

### Plan
- [x] 1. **Rust, gruplar:** model, `display_order`, beş komut ve kayıtları. Birim testleri: eski JSON okunuyor; bozuk grup kaydı workspace'leri silmiyor; var olmayan gruba işaret eden `group` temizleniyor; aynı ad reddediliyor; grup silinince workspace'ler grupsuz kalıyor; silmeden sonra sıradaki workspace görünüm sırasına göre seçiliyor.
- [x] 2. **Rust, ölçek:** `uiScale` ayarı, doğrulaması ve testi; açılışta `set_zoom`; capabilities izni.
- [x] 3. **IPC, store ve sahte IPC:** `ipc.ts` tipleri ve çağrıları; `workspaceStore` (groups alanı, yeni eylemler, grup içi `moveWorkspace`); `layoutStore` (iki yeni alan, açık doğrulamayla); `e2e/setup.ts` içinde grup komutları, 3–4 workspace'li bir test verisi ve kaydedilen `setZoom` çağrıları.
- [x] 4. **Saf mantık ve testleri:** `groupedWorkspaces`, görünen satırlar listesi (imleç için) ve `groupAgents`.
- [x] 5. **UI, gruplar:** `ContextMenu` için `keepOpen`; `WorkspaceList` başlıklar, menüler, satır içi ad kutusu ve klavye; hızlı geçiş listesi; `WorktreesPanel` ve Ctrl+1…9 görünüm sırasına geçer.
- [x] 6. **UI, ajanlar:** `AgentsPanel` durum başlıkları ve daraltma.
- [x] 7. **UI, ölçek:** zoom aboneliği, `unscaledFontSize`, terminal ve üç Monaco kullanımı, Ayarlar alanı, palet komutları.
- [x] 7b. **UI, arayüz fontu:** `uiFontFamily` ayarı (TypeScript ve Rust), `applyTheme` içinde `--font-ui`, Ayarlar alanı. Testler: birim testi, ve e2e'de font değişince `getComputedStyle(body).fontFamily` değerinin değiştiğinin kontrolü.
- [x] 8. **Belgeler:** i18n, D-080 ve D-081, kılavuz, elle test maddeleri.
- [x] 9. **Doğrulama:** aşağıdaki bölüm. Ardından bug-expert diff incelemesi.

**Yürütme:** 1–4. adımları ben yapıyorum, çünkü bu kısım kararlar ve sözleşme içeriyor. 5–7. adımlar dosya sahipliği ayrılmış iki Sonnet ajanına verilebilir: biri gruplar ve ajanlar, diğeri ölçek. Sonunda entegrasyonu ve son kararı ben veriyorum.

### Doğrulama
- **Rust:** `cargo test --workspace` (workspace store ve settings testleri) ve `cargo clippy --workspace --all-targets -- -D warnings`.
- **UI:** `npm --prefix apps/desktop test` ve `npm --prefix apps/desktop run build`.
- **E2E:** Arka planda çalıştırılır.
  - `workspaces.spec.ts` genişletilir: grup oluştur, workspace'i gruba taşı, grubu daralt, sayfayı yenileyince kapalı kaldığını gör, grubu sil ve workspace'in grupsuz kaldığını gör, klavyeyle başlık aç/kapa, Ctrl+1…9 sırası.
  - Ajan grupları için yeni bir senaryo eklenir.
  - Ölçek için: Ayarlar'da %125 seçilince `setZoom(1.25)` çağrılıyor, terminalin font boyutu `15 / 1.25` oluyor.
  - Ekran görüntüleri koyu/açık temada, EN/TR dillerinde alınır ve incelenir.
- **Gerçek uygulama:** `tauri dev` ile %150 ölçekte terminal ve editörün keskin göründüğü ve boyutunun değişmediği kontrol edilir. Bunun için gerektiğinde CDP bağlantısı kullanılır.

### Riskler ve varsayımlar
- **Eski sürüme dönüş:** Eski sürüm yeni alanları okurken yok sayar ama ilk değişiklikte `"workspaces"` bölümünü baştan yazar. Bu durumda gruplar kaybolur. Bu kabul ediliyor ve D-080'e yazılacak.
- **Ctrl+1…9 numaraları değişir:** Kısayollar artık grup sırasını izliyor. Bu bilinçli bir tercih: numaralar ekranda görünen sırayla aynı olsun diye.
- **Biten işin yeri:** Biten işler artık Çalışanların altında, yani bakılmamış iş eskisine göre daha aşağıda görünür. Bu senin seçimin.
- **Zoom ile ince çizgiler:** %110 ve %175 gibi kesirli ölçeklerde 1 px'lik kenarlıklar bulanık görünebilir. Ekran görüntülerinde kontrol edilecek.
- **Kesirli terminal fontu:** xterm'in kesirli font boyutunda (ör. 12) hücre ölçüsünü doğru hesapladığı gerçek uygulamada doğrulanacak. Sorun çıkarsa değer en yakın 0,5'e yuvarlanır.

### ⚠ Senden beklenenler (başlamadan önce)
| # | Karar / eylem | Neden gerekli | İşi durduruyor mu? (Evet/Hayır) | Cevap |
|---|---|---|---|---|
| 1 | Planı onayla. | Yeni veri alanları, beş komut ve yeni bir izin ekleniyor. | Evet | Plan modunda onaylandı (2026-11-25) |

### Kararlar
- 2026-11-25: Grup atama sağ tıkla yapılacak. Ajan sırası Bekleyen › Çalışan › Biten › Boşta. Başlıklar daraltılabilir ve durumları hatırlanacak. (Kullanıcının cevabı.)
- 2026-11-25: Ölçek terminali ve editörü etkilemeyecek. Ayarlar'dan ve komut paletinden değiştirilecek, kısayol yok. (Kullanıcının cevabı.)
- 2026-11-25 (uygulama): Yinelenen grup adı için yeni `duplicate_group` kodu yerine mevcut `already_exists` hata kodu kullanıldı; anlamı aynı, yeni kod gereksizdi.
- 2026-11-25 (uygulama): Ölçek yalnızca Rust'ta uygulanıyor (açılışta ve `settings_set` içinde `set_zoom`). Böylece webview'a yeni izin (`core:webview:allow-set-webview-zoom`) gerekmedi ve ölçeğin uygulandığı tek yer var.
- 2026-11-25 (uygulama): `groups` listesi esnek okunuyor: ayrıştırılamayan tek bir grup kaydı atlanıyor, bütün `"workspaces"` bölümü kaybolmuyor.
- 2026-11-25 (inceleme): Bağımsız hata incelemesi ciddi hata bulmadı, beş küçük kenar durumu buldu; hepsi düzeltildi (ayrıntı B bölümünde). Klavyede grup başlığında Delete artık bir şey yapmıyor: grup yalnızca başlık menüsünden silinir, böylece tek bir yanlış tuş grubu dağıtamaz.
- 2026-11-25: Fable incelemesinden sonra bütün listeyi gönderen tek komut yerine tek işlemli küçük komutlara geçildi. Daraltma durumu Rust yerine `layout` bölümüne taşındı.

## B. RAPOR (iş bittikten sonra)
### Sonuç
Dört parçanın dördü de çalışıyor: workspace grupları, durum bölümlü Ajanlar paneli, arayüz ölçeği (%90–%200) ve arayüz fontu. Otomatik testlerin hepsi geçti; gerçek Tauri penceresinde henüz denenmedi.

### Yapılanlar
- **Workspace grupları:** Rust'ta `groups` ve `Workspace.group` alanları, tek işlemli beş komut, bozuk kayıtlara dayanıklı okuma ve görünüm sırası (`display_order`). Arayüzde grup başlıkları, daraltma, "Gruba taşı…" menüsü, "Yeni grup…" satır içi girişi, başlık menüsü (yeniden adlandır, sil, taşı) ve klavye desteği. Hızlı geçiş listesi, Mission Control ve Ctrl+1…9 aynı sırayı izliyor.
- **Ajanlar paneli:** Bekleyen › Çalışan › Biten › Boşta bölümleri, sayılar, daraltma (hatırlanıyor). Workspace rozeti ve Ctrl+Shift+A'nın aciliyet sırası değişmedi.
- **Arayüz ölçeği:** Ayarlar → Görünüm'de seçim ve komut paletinde üç komut. Rust pencereyi açarken ve ayar değişince yakınlaştırmayı uyguluyor. Terminal ve üç Monaco editörü font boyutunu ölçeğe bölerek kendi boyutunda kalıyor.
- **Arayüz fontu:** Ayarlar → Görünüm'de metin kutusu ve "Varsayılana dön". Virgülle ayrılmış birden çok font yazılabiliyor, bulunamayan font Geist'e düşüyor.
- **Belgeler:** D-080, D-081, kullanıcı kılavuzu (EN/TR), elle test maddeleri WG-1…WG-8 ve UI-1…UI-5.
- **İnceleme düzeltmeleri:** virgüllü font listesi; sayı olan bir `group` değeri artık listeyi silmiyor; yazma başarısız olursa bellekteki durum da eski kalıyor; liste içindeki menü ve onay pencerelerine sağ tık artık "Yeni grup" menüsü açmıyor; başlıkta Delete grubu silmiyor.

### Nasıl doğrulandı
- **Rust:** workspace ve settings testlerinin 66'sı geçti (yeni grup ve ölçek testleri dahil); `cargo clippy --workspace --all-targets -D warnings` temiz.
- **Birim testleri:** tam takımda 1123 testten 1117'si geçti. Kalan 6 test 5 saniyelik zaman aşımıydı (makine yükü). Aynı dosyalar tek başına çalıştırılınca 61 testin hepsi geçti. Düzeltmelerden sonra workspaces, theme, agents ve stores klasörleri yeniden çalıştırıldı, geçti. `tsc` ve `npm run build` temiz.
- **E2E (Playwright):** etkilenen 10 spec, 85 testin hepsi geçti; düzeltmelerden sonra `workspaces.spec.ts` + `ui-scale.spec.ts` yeniden çalıştırıldı, 18 testin hepsi geçti.
- **Ekran görüntüleri** incelendi: gruplu liste (TR, koyu), ajan bölümleri (EN, açık), Görünüm ayarları (TR, koyu).
- **Doğrulanamayanlar:** Gerçek pencerede yakınlaştırma (sahte IPC'de webview zoom yok; test yalnızca terminale verilen font boyutunu ölçüyor), kesirli terminal fontunun keskinliği ve daraltma durumunun yeniden başlatmada korunması (sahte IPC `layout` bölümünü saklamıyor; bu yalnızca birim testiyle kapsanıyor).

### Değişen nesneler / dosyalar
- Rust: `src-tauri/src/workspace/{model,store}.rs`, `commands/{workspace,settings}.rs`, `settings/mod.rs`, `lib.rs`.
- Arayüz: `lib/ipc.ts`, `stores/{workspaceStore,layoutStore,settingsStore}.ts`, `features/workspaces/{groups.ts,WorkspaceList.tsx,WorkspaceSwitcher.tsx,ContextMenu.tsx}`, `features/worktrees/WorktreesPanel.tsx`, `features/agents/{agentLogic.ts,AgentsPanel.tsx}`, `app/App.tsx`, `app/ui/{uiScale,uiScaleCommands}.ts`, `app/theme/{applyTheme,themeSync}.ts`, terminal (`terminalRegistry.ts`, `TerminalView.tsx`), viewer (`TextEditor.tsx`, `DiffView.tsx`, `ExternalChangeBanner.tsx`), `features/settings/AppSections.tsx`, i18n `en.ts`/`tr.ts`, `e2e/setup.ts`.
- Testler: `groups.test.ts`, `WorkspaceList.test.tsx`, `uiScale.test.ts`, `uiFont.test.ts`, `agentLogic.test.ts`, `layoutStore.test.ts`, `SettingsPage.test.tsx`, `e2e/workspaces.spec.ts`, `e2e/ui-scale.spec.ts`.
- Belgeler: `docs/DECISIONS.md`, `docs/manual-tests.md`, `apps/desktop/docs/user-guide.md`, `apps/desktop/docs/tr/user-guide.md`.

### Yapılmayanlar ve açık kalanlar
- Silinen grupların id'leri `layout.collapsedWorkspaceGroups` listesinden temizlenmiyor. Zararsız, liste yalnızca birkaç kısa metin büyüyor.
- Yan pencereler (dikte, maskot, asistan) ölçeklenmiyor; kapsam dışı bırakılmıştı.
- Commit yapılmadı; kullanıcı isteyince.

### ⚠ Senden beklenenler (şimdi)
| # | Eylem | Neden | Aciliyet | İşi durduruyor mu? (Evet/Hayır) |
|---|---|---|---|---|
| 1 | `tauri dev` ile elle dene: WG-1…WG-8 ve UI-1…UI-5 (`docs/manual-tests.md`). Özellikle %125/%150'de terminal ve editörün keskinliği, yeniden başlatınca ölçeğin zıplamadan gelmesi. | Gerçek yakınlaştırma ve kalıcılık otomatik testlerde denenemiyor. | Sürümden önce | Hayır |
| 2 | Sürüm listesindeki diğer işlerle birlikte commit isteyip istemediğine karar ver. | Commit yalnızca istek üzerine. | Sürümden önce | Hayır |

### Sonraki oturum için not
Her şey commit'lenmemiş halde `main` üzerinde, sürüm listesi `tasks/2026-11-22-ui-surumu.md` (madde 10). Tam vitest takımı yük altında 5 sn zaman aşımlarıyla birkaç test düşürüyor; bunlar tek başına geçiyor. E2E'de sahte IPC `layout` bölümünü saklamaz.
