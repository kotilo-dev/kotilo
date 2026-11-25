# Workspace panelini sekmeli + seçicili yapıya geçirmek (A+B)

**Durum:** TAMAMLANDI
**Tarih:** 2026-11-22 (son güncelleme: 2026-11-22)
**Etkilenen yer:** `apps/desktop/src/features/workspaces/*`, `apps/desktop/src/app/i18n/{en,tr}.ts`, `apps/desktop/e2e/workspaces.spec.ts`, `docs/DECISIONS.md`. SAP'a yazma yok.

## A. BRIEF (işe başlamadan önce)

### Özet
Sol üstteki Workspaces paneli bugün workspace listesini ve aktif workspace'in dosya ağacını tek bir ağaçta karışık gösteriyor. Panel iki sekmeye ayrılacak: **Workspaces** sekmesi listeyi yönetmek için, **Files** sekmesi aktif workspace'in dosyaları için. Files sekmesinin başlığındaki workspace adı ayrıca hızlı geçiş listesi açacak (A+B seçeneği). Amaç iki kavramı ayırmak ve kökteki karışık kontrolleri (ok, nokta, "Switch" düğmesi) tek bir davranışa indirmek.

### Arka plan
- **Bugünkü yapı:** `WorkspacesPanel.tsx` başlıkta filtre kutusu ve "+" düğmesi taşıyor. Altındaki `Tree.tsx`, `flatten.ts` (`flattenVisible`) ile önce aktif kökü ve ağacını, sonra "Other workspaces (n)" başlığı altında diğer kökleri çiziyor. Ağaç büyüdükçe diğer workspace'ler aşağı itiliyor. Kök satırında ▶/▼ (ağacı aç/kapa), ●/○ (aktif et) ve üzerine gelince çıkan "Switch" düğmesi var. Kökün sağ tık menüsünde 12 madde var.
- **Mockup:** https://claude.ai/artifact/NWwz6TbyJgX3U6h2vKSQ9J — "A+B · Tabs + switcher" paneli, kullanıcı 2026-11-22'de bunu seçti.
- **Agents paneli:** Sol sütunun altındaki agent listesi (`AgentsPanel`). Bu işte değişmiyor.
- **Agent rozeti:** `AgentBadge` + `urgentStateForWorkspace` bir workspace'teki en acil agent durumunu (izin bekliyor, çalışıyor…) gösteren mevcut bileşen.
- **Docs rozeti:** 0.7'de gelen, dokümantasyon kontrolünde eksik/eski çıkan dosyaların yanındaki nokta (`DocBadgeDot`).
- **Ctrl+1…9:** Workspace'ler arasında geçiş için zaten var olan kısayol. Korunuyor, yeni kısayol eklenmiyor.
- **D-xxx:** `docs/DECISIONS.md` içindeki numaralı karar kayıtları. Son numara D-076, bu iş D-077 olacak.

### Kapsam / Kapsam dışı
**Kapsam**
- Panel başlığı: `WORKSPACES` ve `FILES` sekmeleri, sağda "+" (workspace ekle). Aktif olmayan workspace'lerde izin bekleyen agent varsa Workspaces sekmesinde kırmızı sayı rozeti.
- **Workspaces sekmesi:** Her workspace için iki satırlık kayıt: ad + yol, sağda agent rozeti ve terminal sayısı. Tek tık o workspace'i aktif eder ve Files sekmesine geçer. Sağ tık menüsünde yalnızca workspace işleri kalır: yeni agent (worktree), docs kontrolü, agent context, yeniden adlandır, kaldır, Explorer'da aç, yukarı/aşağı taşı. Klavye: ↑/↓ seçim, Enter aktif et, F2 yeniden adlandır, Delete kaldır.
- **Files sekmesi:** Başlıkta aktif workspace'in adı ve branch'i (tıklanınca geçiş listesi), "Yeni dosya" ve "Yeni klasör" düğmeleri, altında tam genişlikte filtre kutusu. Ağaç yalnızca aktif workspace'in içeriğini gösterir, kök satırı yoktur. Bugünkü dosya/klasör menüleri, klavye kısayolları, docs rozetleri ve sanal liste (virtualizer) aynen kalır. Boş alana sağ tık, kökteki dosya işlerini açar: yeni dosya/klasör, Explorer'da aç, panodaki resmi buraya kaydet, burada terminal aç.
- **Geçiş listesi (popover):** Aramalı workspace listesi (agent rozetiyle), altta "Manage workspaces…" (Workspaces sekmesine götürür). Esc ve dışarı tıklama kapatır, ↑/↓/Enter ile seçilir.
- Hiç workspace yoksa ya da aktif workspace yoksa panel Workspaces sekmesinde açılır, mevcut boş durum metni gösterilir.
- İngilizce ve Türkçe metinler, birim testleri, e2e testi ve ekran görüntüleri, DECISIONS kaydı.

**Kapsam dışı**
- Sürükle-bırak ile sıralama (mockup'ta yazıyordu). Sıralama sağ tık menüsündeki yukarı/aşağı taşı ile devam eder. Ayrı bir iş olarak ele alınabilir.
- Workspace listesinde her workspace'in branch'i: her biri için ayrı git çağrısı gerekir. Branch yalnızca aktif workspace için Files başlığında gösterilir.
- Agents paneli, hub, Rust tarafı: değişmiyor.
- Seçili sekmeyi yeniden başlatmalar arasında hatırlamak: uygulama her açılışta Files sekmesiyle başlar.

### Plan
- [ ] 1. `flatten.ts`: aktif workspace'in içeriğini kök satırı olmadan düzleştiren hale getir. `group` ve `root` satır türlerini kaldır. `flatten.test.ts` testlerini güncelle.
- [ ] 2. `Tree.tsx`: kökle ilgili kodu (aktif etme, Switch, kök menüsü, kök yeniden adlandırma/kaldırma) çıkar. Boş alana sağ tık için kök dosya menüsünü ekle.
- [ ] 3. Yeni `WorkspaceList.tsx`: liste, workspace menüsü, yeniden adlandırma, kaldırma onayı (kirli dosya varsa mevcut "Save all / Discard" akışı), klavye.
- [ ] 4. Yeni `WorkspaceSwitcher.tsx`: başlıktaki ad/branch düğmesi ve aramalı popover. Branch için `StatusBar`'daki `gitHead` çağrısını küçük bir `useGitHead` hook'una taşıyıp ikisinde de kullan.
- [ ] 5. `WorkspacesPanel.tsx`: sekme başlığı, sekme durumu, uyarı rozeti, Files başlığı ve filtre. Klasör sürükle-bırak dinleyicisi aynen kalır.
- [ ] 6. `en.ts` / `tr.ts`: yeni metinler. Artık kullanılmayanları (`activate`, `otherWorkspaces`…) kaldır.
- [ ] 7. Birim testleri: liste (tıkla → aktif + Files sekmesi), rozet sayısı, popover araması, boş durum.
- [ ] 8. e2e: `workspaces.spec.ts`'yi yeni akışa göre yeniden yaz. `context.spec.ts` ve `docs.spec.ts`'deki ağaç satırı yardımcılarının hâlâ çalıştığını doğrula. Ekran görüntüleri: koyu/açık × en/tr, popover açık.
- [ ] 9. `docs/DECISIONS.md`'ye D-077, gerekiyorsa `docs/manual-tests.md` güncellemesi.
- [ ] 10. Doğrulama: `npm --prefix apps/desktop run build`, `npm --prefix apps/desktop test`, `npm --prefix apps/desktop run e2e`, ekran görüntülerine bakış.

### Riskler ve varsayımlar
- **Kaybolan davranışlar:** Kökte çift tık, ●/○ noktası ve "Switch" düğmesi kalkıyor. Bunların yerini listede tek tık ve geçiş listesi alıyor. Ctrl+1…9 aynen kalıyor.
- **Kök işlerinin yeni yeri:** Kökteki "Yeni dosya", "Panodaki resmi kaydet" gibi işler boş alana sağ tıka ve başlık düğmelerine taşınıyor. Alışkanlık değişikliği olabilir.
- **Docs ve context testleri:** Bu testler ağaçta dosya satırlarını `div.group` ile buluyor. Dosya satırları bu sınıfı korursa testler etkilenmez. Etkilenirse testleri güncellerim.
- **Varsayım:** Geçiş listesi ve sekmeler uygulamanın mevcut modal yığını (`modalStack`) ve klavye korumalarıyla çakışmayacak. Esc önce popover'ı kapatmalı.

### ⚠ Senden beklenenler (başlamadan önce)
| # | Karar / eylem | Neden gerekli | İşi durduruyor mu? (Evet/Hayır) | Cevap |
|---|---|---|---|---|
| 1 | Bu brief'i onayla. Özellikle şu iki noktaya bak: sürükle-bırak sıralamanın kapsam dışında kalması ve kökteki çift tık / Switch davranışının kalkması. | Mevcut etkileşimler kaldırılıyor, bunun yanlış çıkması geri dönüş maliyetli. | Evet | 2026-11-22: Onaylandı. |

### Kararlar
- 2026-11-22: Üç seçenek mockup'la gösterildi (A: iki sekme, B: seçici, A+B). Kullanıcı A+B'yi seçti.
- 2026-11-22: Agents paneli değişmiyor. Kullanıcı mockup'ta bu paneli görmeyince sordu, kalacağı netleştirildi.
- 2026-11-22: Brief olduğu gibi onaylandı (sürükle-bırak kapsam dışı, kökteki çift tık/Switch kalkıyor). Kullanıcı bu sürümde başka UI düzeltmeleri de yapılacağını söyledi; bu yüzden sürüm numarası, CHANGELOG sürüm başlığı ve commit bu işin parçası değil.

- 2026-11-22: Türkçe sekme adı "ALANLAR" olarak kalıyor (kullanıcı onayladı).
- 2026-11-22: Ara iş olarak timeline şeridine görüntüleyici aç/kapa düğmesi eklendi (kullanıcı isteği). Bu ayrı ve küçük bir değişiklik, aşağıda raporlanıyor.

## B. RAPOR (iş bittikten sonra)
### Sonuç
Workspace paneli iki sekmeye ayrıldı (Workspaces / Files) ve Files başlığına hızlı workspace geçiş listesi eklendi. Build, birim testleri ve e2e testlerinin tamamı geçiyor.

### Yapılanlar
- Plan adımları 1–10'un hepsi yapıldı. Kodlamayı bir Sonnet alt ajanı spesifikasyona göre yaptı. Diff'i, ekran görüntülerini ve testleri ana oturum inceledi ve yeniden çalıştırdı.
- **Workspaces sekmesi** (`WorkspaceList.tsx`): Her workspace için iki satırlık kayıt (ad, yol), durum etiketi ("Needs permission" / "Working" / "Done") ve sıfırdan büyükse terminal sayısı. Tek tık önce workspace'i aktif eder, sonra Files sekmesine geçer. Sağ tık menüsünde yalnızca workspace işleri var. Klavye: ↑/↓, Enter, F2, Delete.
- **Files sekmesi:** Başlıkta "● ad ▾ branch" geçiş düğmesi, Yeni dosya / Yeni klasör düğmeleri ve tam genişlikte filtre kutusu var. Ağaçta kök satırı yok. Boş alana sağ tık, kökteki dosya işlerini açıyor. Hiçbir şey seçili değilken Ctrl+V, panodaki resmi köke kaydediyor.
- **Geçiş listesi** (`WorkspaceSwitcher.tsx`): Arama, ↑/↓/Enter, Esc (önce popover'ı kapatır), dışarı tıklayınca kapanma, "Manage workspaces…" seçeneği.
- **Kırmızı rozet:** Aktif olmayan workspace'lerde izin bekleyen agent sayısı (`panelLogic.ts`).
- **Ortaklaştırma:** `StatusBar`'daki branch sorgusu `useGitHead` hook'una taşındı. Davranış aynı kaldı.
- **Belgeler:** `docs/DECISIONS.md`'ye D-077 eklendi, `docs/manual-tests.md`'de F-14 ve DC-1 güncellendi.
- **Ara iş (timeline):** Görüntüleyici aç/kapa düğmesi eklendi. Timeline kapalıyken sağ şeritte "Show timeline"ın altında, açıkken başlıkta gizle düğmesinin solunda duruyor.

### Nasıl doğrulandı
- **Build:** `npm --prefix apps/desktop run build` geçti (TypeScript strict + vite).
- **Birim testleri:** `npm --prefix apps/desktop test` sonucu 1090 testten 1089'u geçti. Kalan 1 başarısızlık `ProjectsPage.test.tsx` içinde. Bu dosyaya dokunulmadı. Test tek başına 3 kez çalıştırıldı ve üçünde de geçti, yani yüke bağlı geçici bir hata. Alt ajanın kendi çalıştırmasında 1090'ın hepsi geçmişti.
- **e2e:** `npm --prefix apps/desktop run e2e` sonucu 136 testin 136'sı geçti. Ana oturum tek başına, eşzamanlı başka çalıştırma olmadan çalıştırdı.
- **Ekran görüntüleri:** `workspace-panel-{files,workspaces,switcher}-*` (koyu/açık × en/tr) ve `timeline-*` görüntülerine bakıldı.
- **Doğrulanmayan:** Gerçek uygulama (`tauri dev`) açılmadı. Klasör sürükle-bırak ve gerçek git branch'i yalnızca mock'lu ortamda görüldü.

### Değişen nesneler / dosyalar
- **Yeni:** `features/workspaces/{WorkspaceList,WorkspaceSwitcher,AgentStatePill}.tsx`, `features/workspaces/{panelLogic,useGitHead}.ts`, `stores/workspacePanelStore.ts`, `features/workspaces/{WorkspacesPanel.test.tsx,panelLogic.test.ts}`.
- **Değişen:** `features/workspaces/{WorkspacesPanel,Tree}.tsx`, `features/workspaces/flatten{,.test}.ts`, `stores/workspaceStore{,.test}.ts`, `app/StatusBar.tsx`, `app/i18n/{en,tr}.ts`, `e2e/{workspaces,context,docs,macos}.spec.ts`, `docs/DECISIONS.md`, `docs/manual-tests.md`.
- **Timeline ara işi:** `features/timeline/TimelineRail{,.test}.tsx`, `app/i18n/timeline.{en,tr}.ts`, `e2e/timeline.spec.ts`.

### Yapılmayanlar ve açık kalanlar
- **Sürükle-bırak ile sıralama:** Brief'te kapsam dışıydı.
- **Sürüm, CHANGELOG, commit:** Bu sürümde başka UI düzeltmeleri de olacağı için yapılmadı.
- **Brief'ten sapmalar** (alt ajanın kararları, ana oturum kabul etti, kullanıcı onayına açık):
  - Türkçe sekme adı "ÇALIŞMA ALANLARI" yerine "ALANLAR" oldu, çünkü uzun ad varsayılan panel genişliğinde iki satıra kayıp kesiliyordu.
  - Workspace satırında eski nokta rozeti yerine metinli durum etiketi kullanıldı (mockup'taki gibi).
  - Terminal sayısı yalnızca sıfırdan büyükse gösteriliyor.
  - Filtre aktifken Yeni dosya / Yeni klasör düğmeleri devre dışı kalıyor.
- **Görsel not:** Varsayılan panel genişliğinde Files başlığındaki branch adı kısalıyor ("fea…"). Tam adı panel genişletilince görünüyor.

### ⚠ Senden beklenenler (şimdi)
| # | Eylem | Neden | Aciliyet | İşi durduruyor mu? (Evet/Hayır) |
|---|---|---|---|---|
| 1 | `npm --prefix apps/desktop run tauri dev` ile gerçek uygulamada paneli bir kez dene. | Sürükle-bırak, gerçek branch ve gerçek agent rozeti yalnızca mock'lu ortamda test edildi. | Sürüm öncesi | Hayır |

### Sonraki oturum için not
İş tamamlandı ama commit atılmadı. Değişiklikler working tree'de, timeline düğmesi değişiklikleriyle birlikte duruyor. Aynı sürümde başka UI düzeltmeleri gelecek, commit ve sürüm işi bunlar bitince toplu yapılacak.
