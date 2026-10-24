# Kotilo – Design System

> v0.1 · 2026-10-04 · Referans mockup'lar: `docs/design/mockups/{Main,Permission,MissionControl}.dc.html`.
> Uygulama: React + Tailwind 4. Tüm değerler CSS değişkeni (token) olarak `:root` üzerinde tanımlanır; bileşenler ham hex kullanmaz.

## 1. İlkeler

1. **Terminal gerçek kaynaktır.** Ajanın kendi arayüzü bozulmaz; zenginlik terminalin *çevresindedir* (başlık şeridi, kartlar, yan panel).
2. **Durum her şeyden önce gelir.** Bir bakışta hangi ajanın beni beklediği anlaşılmalı. Renk + şekil + hareket birlikte kullanılır (yalnızca renk değil).
3. **Sessiz yüzey, canlı sinyal.** Arka plan koyu ve düşük kontrastlı katmanlar; vurgu yalnızca durum ve eylem için.
4. **Klavye önce.** Her eylemin kısayolu var ve arayüzde görünür (Enter, Esc, Ctrl K).
5. **Marka nötr.** Ajanlar harf + renkle ayırt edilir; hiçbir sağlayıcının logosu ya da renk kimliği ürün markası gibi kullanılmaz.

## 2. Renk

### 2.1 Yüzeyler (koyu tema – varsayılan)

| Token | Değer | Kullanım |
|---|---|---|
| `--bg` | `#0b0c0f` | Pencere zemini |
| `--surface-1` | `#0f1014` | Kenar çubukları, raylar |
| `--surface-2` | `#111318` | Panel / kart gövdesi |
| `--surface-3` | `#14161b` | Panel başlığı, giriş kutusu |
| `--surface-4` | `#181a20` | Seçili kart, açılır kartlar |
| `--surface-5` | `#1b1e24` | İkon butonları, rozetler |
| `--track` | `#22252d` | İlerleme çubuğu zemini |
| `--terminal-bg` | `#0e1014` | Terminal ve kod alanı |
| `--border` | `rgba(255,255,255,0.06)` | Ayırıcılar |
| `--border-strong` | `rgba(255,255,255,0.08)` | Kontroller |

### 2.2 Metin

| Token | Değer | Kullanım |
|---|---|---|
| `--text` | `#e7e9ee` | Birincil |
| `--text-2` | `#c9ccd4` | İkincil yoğun |
| `--text-3` | `#a3a8b4` | Etiket |
| `--text-muted` | `#7d8290` | Açıklama, meta |
| `--text-faint` | `#6f7480` | Bölüm başlığı (uppercase), ipucu |

`--text-faint` yalnızca ≥11px büyük harfli başlıkta veya dekoratif metinde; gövde metninde en az `--text-muted` (4.5:1 kontrast hedefi).

### 2.3 Vurgu ve durum

| Token | Değer | Anlam |
|---|---|---|
| `--accent` | `#7c9cff` | Birincil eylem, seçim, context çubuğu, prompt işareti |
| `--status-working` | `#f2b440` | Çalışıyor (amber) |
| `--status-blocked` | `#ff6b5a` | İzin / cevap bekliyor (kırmızı-turuncu) |
| `--status-done` | `#5aa9ff` | Bitti, henüz bakılmadı (mavi) |
| `--status-idle` | `#46c58a` | Boşta / başarılı (yeşil) |
| `--status-error` | `#ff6b5a` + ⚠ ikonu | Hata / limit doldu (blocked ile aynı renk, farklı ikon) |

Her durum rengi için yarı saydam zemin (`rgba(… ,0.12–0.16)`) ve açık mürekkep (`--status-*-ink`) varyantı vardır: working-ink `#f6c86b`, blocked-ink `#ff9d90`, done-ink `#9cc8ff`, idle-ink `#8fe0b6`. Kırmızı/yeşil yalnız başına ayırt edici değildir: durumlar ayrıca **ikon ve hareket** ile ayrılır (§6).

### 2.4 Ajan kimlik renkleri

Avatar = 28–36px köşeli kare, harf + koyu zemin + açık mürekkep. Kaynak her ajanın `adapters/<id>/adapter.json` `avatar` alanıdır; yerleşik ajanlar `--agent-<key>-*` token'larıyla çizilir (değerler adapter.json ile aynı, `agentIdentity.test.ts` denetler). Özel (kullanıcı) ajanlar sihirbazdaki sabit paletten seçer (durum/ANSI mürekkepleri; zemin = mürekkebin `--bg` üzerinde %14 karışımı) ve renkleri kendi dosyalarından satır içi uygulanır.

| Ajan | Harf | Zemin | Mürekkep |
|---|---|---|---|
| Claude Code | C | `#2a2230` | `#f0a37d` |
| Codex CLI | X | `#1d2a26` | `#7fd8b4` |
| GitHub Copilot CLI | P | `#1f2430` | `#a5c8ff` |
| Gemini CLI | G | `#1e2433` | `#8ab4f8` |
| OpenCode | O | `#26231e` | `#f0d9a8` |
| Cursor CLI | U | `#21252b` | `#d3dae3` |
| Qwen Code | Q | `#262236` | `#b39cf5` |
| Factory Droid | D | `#2b2620` | `#f2b56b` |

### 2.5 Açık tema

v1'de tanımlanacak; token adları aynı kalır, değerler `[data-theme="light"]` altında. Kural: yüzey sırası korunur (bg en açık değil, panel en açık), durum renkleri bir ton koyulaştırılır (kontrast ≥ 3:1 ikon, ≥ 4.5:1 metin).

## 3. Tipografi

| Rol | Font | Boyut / satır | Ağırlık |
|---|---|---|---|
| UI | **Geist** | 13 / 1.45 | 400, 500, 600, 700 |
| Terminal / kod / sayı | **Geist Mono** (ligatür açık) | 13.5 / 1.6 (terminal), 12 (sayılar) | 400–600 |
| Ekran başlığı | Geist | 26 / 1.2, `letter-spacing: -0.02em` | 700 |
| Panel başlığı | Geist | 14 | 600 |
| Bölüm etiketi | Geist | 11, uppercase, `letter-spacing: 0.08em` | 600 |
| Meta | Geist | 11.5–12 | 400–500 |

- Tailwind boyut sınıfları (`index.css` `@theme`): `text-label` 11 · `text-meta` 11.5 · `text-small` 12 · `text-body` 12.5 · `text-ui` 13 · `text-title` 14 · `text-display` 26. 11px altı metin yok.
- Sayılar (token, %, $, süre) her zaman Geist Mono → hizalı ve okunaklı.
- Fontlar uygulamayla gömülür (OFL lisansı); ağ üzerinden yüklenmez.
- Terminal fontu kullanıcı ayarıyla değiştirilebilir (varsayılan Geist Mono, yedek Cascadia Code, Consolas).

## 4. Boşluk, ızgara, köşe, gölge

- 4px temel ızgara. Sık kullanılan: 4, 6, 8, 10, 12, 14, 16, 18, 22, 28, 32.
- Panel iç boşluğu 12–16px; terminal iç boşluğu **18px 22px** (terminalin "ürün" hissi için kritik).
- Köşe yarıçapı: 4 (rozet), 6–7 (küçük kontrol), 8–9 (buton, avatar), 10 (kart), 12 (panel), 14 (izin kartı, görev kartı).
- Gölge: yalnızca yüzen öğelerde. İzin kartı `0 18px 50px rgba(0,0,0,.55)`. Durum halesi: `0 0 0 4px <status @ 0.05–0.08>` + gerekirse `0 0 40px <status @ 0.10>`.
- Modal arka perdesi: `--scrim` (`bg-scrim`; koyu `rgba(0,0,0,.5)`, açık `rgba(15,20,35,.3)`) – tüm diyaloglar, Yardım, komut paleti.
- Pencere: Windows 11'de Mica (Tauri `window-vibrancy`), Mac'te vibrancy; desteklenmezse `--bg`.

## 5. İkonlar

- 24px ızgarada, `stroke-width` 2 (küçükte 2.2–2.5), `stroke-linecap: round`, dolgusuz. Lucide uyumlu set.
- Araç ikonları zaman akışında harfli kare: R (Read), E (Edit/Write), B (Bash), W (Web), T (Task/subagent) – renk araç sonucuna göre (çalışıyor amber, hata kırmızı, bitti nötr).
- Emoji kullanılmaz.

## 6. Hareket

| Ad | Tanım | Kullanım |
|---|---|---|
| `spin` | 1s, 8 adım (`steps(8)`), 360° | Çalışan araç / ilerleme halkası |
| `pulse` | 1.4s, dışa açılan hale (sözde öğede `transform` + `opacity`) | Blocked durum noktası |
| `rise` | 0.25s ease-out, 12px yukarı + opaklık | İzin kartı, bildirim şeridi |
| Geçiş | 120–180ms ease | Hover, sekme, seçim |

Sürekli animasyonlar yalnız `transform` ve `opacity` kullanır (her karede yeniden boyama yok). Pencere odakta değilken ya da gizliyken duraklar; `prefers-reduced-motion` açıksa pulse/spin durur. Durum yine ikon ve renkle anlaşılır. (0.3.5: Working etiketindeki shimmer kaldırıldı, her karede metni yeniden boyuyordu.) 0.3.7: `transform` animasyonu da WebView2'de tüm pencereyi her karede birleştirir; spin bu yüzden saniyede 8 adım atar. Ajan yalnız arka plan işini bekliyorsa (Working + arka plan görevi) halka dönmez.

## 7. Bileşenler

Her bileşen: anatomi · durumlar · erişilebilirlik. (Mockup'taki karşılığı parantez içinde.)

### 7.1 Başlık çubuğu (1)
Uygulama işareti + ad, workspace sekmeleri (sekme başında durum noktası), komut paleti alanı ("Search or run a command · Ctrl K"), en kritik limit rozeti. Sekmeler başlık çubuğuna gömülü, aktif sekme `--surface-3` + üst köşeler 8px.

### 7.2 Oturum kartı (1, sol)
Avatar · proje · "ajan · branch" · durum noktası; altında son mesajın tek satırı; en altta durum metni (durum renginde) + göreli zaman. Seçili: `--surface-4` + `1px rgba(accent,0.35)`. Blocked noktada hale.

### 7.3 Ajan başlık şeridi (1, 2)
Avatar · proje + "ajan · branch · model" · **durum etiketi** · boşluk · context çubuğu (120px) · oturum token/maliyet · panel eylemleri. Durum etiketi: 26px yükseklik, 13px yarıçap, durum zemini + mürekkep, Working'de spin ikonu, Blocked'da pulse noktası.

### 7.4 Ajan paneli çerçevesi (1, 2)
Çalışırken `1px rgba(working,0.28)` + 4px hale; izin beklerken `1px rgba(blocked,0.55)` + hale + yumuşak parıltı; boşta nötr `--border`.

### 7.5 İzin kartı (2)
Terminal alanının altında yüzen kart. Başlık: kalkan ikonu + "<Ajan> wants to run a command" + "proje · waiting 1m 12s" + **risk etiketi** (örn. "Writes to a database", "Deletes files", "Network access"). Gövde: komut / dosya yolu kod bloğu. Eylemler: **Allow once** (birincil, Enter), **Always allow in this project**, **Deny** (Esc, kırmızı kenarlı), sağda "Answer in terminal" bağlantısı. Sonuç: yeşil (izin) / mavi (ret) şerit, hangi tuşun gönderildiğini söyler. Odak kart açılınca birincil butona gelir.

### 7.6 Giriş kutusu – composer (1)
`❯` işareti · tek satır girdi (çok satıra genişler) · eklenen bağlam rozetleri (`@approval.ts`) · mikrofon (dikte) · gönder (accent). Terminale yazmayı engellemez.

### 7.7 Zaman akışı (1, sağ)
"Plan" bölümü: ilerleme çubuğu + todo satırları (bitti: üstü çizili, aktif: amber çerçeve). "Activity": araç kare ikonu + hedef + "araç · sonuç · zaman". "Changed files": dosya + `+n −m` (yeşil/kırmızı), tıklayınca diff.

### 7.8 Görev kontrol kartı (3)
Başlık (avatar, proje, ajan · branch, durum etiketi) · canlı terminal önizlemesi (132px, 5 satır, Geist Mono 11.5) · alt meta (bekleme süresi / context, maliyet). Dikkat isteyen kart kırmızı kenar + hale. Tüm kart bağlantıdır (klavyeyle odaklanabilir).

### 7.9 Limit göstergesi (1, 3)
Etiket + değer (Mono) · 5–6px çubuk · not ("resets 14:00"). Renk: <70% accent, 70–90% working, >90% blocked.

### 7.10 Butonlar ve kontroller
- Birincil: accent zemin, `#0b0c0f` metin, 9px yarıçap, 36–38px yükseklik.
- İkincil: `--surface-5`/`#1f2229` zemin + `--border-strong`.
- Tehlikeli: şeffaf zemin + `rgba(blocked,0.35)` kenar + blocked-ink metin.
- İkon butonu: 26–36px kare, `aria-label` zorunlu.
- Kısayol ipucu: Mono 11px, `opacity .6`, butonun içinde.
- Filtre / segment: `--surface-3` kap içinde, seçili `#262a33`.
- Dokunma hedefi ≥ 32px (masaüstü), birincil eylemler 36px+.

### 7.11 Bildirimler
Sistem bildirimi (Windows toast) metinleri durum emojisiz; başlık "<proje>: <durum>", gövde mesaj, butonlar "Go to agent", "Mute 1 h". Uygulama içi şerit `rise` ile alttan.

## 8. Terminal teması

xterm.js tema nesnesi tokenlardan üretilir; ANSI paleti:

| Renk | Normal | Parlak |
|---|---|---|
| black | `#1b1e24` | `#4a4f5c` |
| red | `#ff6b5a` | `#ff9d90` |
| green | `#46c58a` | `#7fd8a4` |
| yellow | `#f2b440` | `#f6c86b` |
| blue | `#7c9cff` | `#9fb4ff` |
| magenta | `#c792ea` | `#d29bf0` |
| cyan | `#5ccfe6` | `#86c8f0` |
| white | `#c9ccd4` | `#e7e9ee` |

Arka plan `--terminal-bg`, imleç `--accent` (çubuk, yanıp söner), seçim `rgba(124,156,255,0.25)`. WebGL renderer açık. Ek hazır temalar: Tokyo Night, Catppuccin Mocha, One Dark, Rosé Pine (kullanıcı seçer; arayüz tokenları değişmez).

## 9. Erişilebilirlik

- Metin kontrastı ≥ 4.5:1, büyük metin ve ikon ≥ 3:1.
- Görünür odak halkası: `2px solid var(--accent)` + 2px offset.
- Gerçek `<button>`, `<a href>`, `<input>` + `<label>`; ikon-butonlarda `aria-label`.
- Durum değişimleri ekran okuyucuya `aria-live="polite"` (blocked için `assertive`).
- Tüm eylemler klavyeyle; global: Ctrl K (palet), Ctrl Shift A (sıradaki bekleyen ajan), Ctrl P (dosya).

## 10. Metin ve ton

- Arayüz dili İngilizce (varsayılan) + Türkçe; kısa, eylem odaklı ("Allow once", "Needs permission").
- Durum adları sabit: Working · Needs permission · Waiting for input · Done · Idle · Error · Silent.
- Sayılar: `312k`, `1.24 M`, `$4.82`, `2m 14s`, `41%`.
- Belirsiz veri uydurulmaz: "—" veya "No data from this agent".
