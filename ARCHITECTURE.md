# Kotilo – Architecture

> v0.1 · 2026-10-04 · Bu belge hedef mimariyi ve iki mevcut koddan aktarım planını tanımlar. Kararlar ileride `DECISIONS.md`'ye (D-xxx) yazılır.

## 1. Genel görünüm

```
┌──────────────────────────────── Desktop app (Tauri 2) ────────────────────────────────┐
│  UI (React 18 + TS + Tailwind 4 + xterm.js + Monaco)                                  │
│    workspace · terminals · viewer · agent header/permission card · mission control     │
│    usage/reports · tasks · dictation · settings                                        │
│            ▲  Tauri invoke / events / per-pane byte channel                            │
│  Rust core (src-tauri)                                                                 │
│    pty (ConPTY / posix pty) · workspaces & file watch · window/tray/hotkeys            │
│    platform layer: text injection, overlay, focus, process tree                        │
│    hub client (HTTP + WebSocket to hub) · hub supervisor (sidecar lifecycle)           │
└───────────────▲──────────────────────────────────────────────────────▲───────────────┘
                │ local HTTP + WS (127.0.0.1, random port, token)       │ spawn / restart
┌───────────────┴────────────── Hub (.NET 10, headless sidecar) ───────┴───────────────┐
│  Ingest API  ←── agent hooks / plugins (via `agenthub-hook` sidecar, spool fallback)  │
│  Agent adapters (Claude Code, Codex, Copilot, Gemini, Qwen, Droid, OpenCode, Cursor)  │
│  Session tracker + state machine · Rule engine (notifications)                        │
│  Usage: transcript/DB readers → pricing → aggregates · Plan limits                    │
│  Projects/todos/git · Personal tasks · Insights (wait metrics, daily summary)         │
│  Dictation: Whisper (Whisper.net) · AI runner (vendor CLIs headless)                  │
│  SQLite (WAL) · settings.json · logs                                                  │
└──────────────────────────────────────────────────────────────────────────────────────┘
       ▲ stdin JSON                                         reads (never writes)
┌──────┴──────────┐                              ~/.claude, ~/.codex, ~/.copilot, ~/.gemini,
│ agenthub-hook   │  ← called by each agent's    ~/.qwen, ~/.factory, opencode.db, ~/.cursor …
│ (Rust, tiny)    │    hook / notify mechanism
└─────────────────┘
```

**Neden iki süreç?** Arayüz ve terminal AgentDeck'te (Rust/React) olgun ve platformlar arası; veri ve iş mantığı CCC'de (C#) olgun ve testli. Birini yeniden yazmak aylar alır ve yeni değer üretmez. Hub, arayüzden bağımsız çalışabildiği için ileride CLI / Command Palette uzantısı / başka istemciler de aynı API'yi kullanır.

## 2. Bileşenler ve sorumluluklar

### 2.1 Desktop app (`apps/desktop`)
- Pencere, tray, global kısayollar (Tauri global-shortcut), sistem bildirimleri (tek sahip: burası; hub "bildirim isteği" olayı yayınlar).
- PTY: `portable-pty` (Windows ConPTY, Mac/Linux posix). Panel başına Job Object (Win) / process group (posix). Her ajan paneline `AGENTHUB_PANE_ID`, `AGENTHUB_WORKSPACE_ID`, `AGENTHUB_ENDPOINT` ortam değişkenleri.
- Ajan başlatma, nazik kapanış dizileri, izin kartı tuş gönderimi (adaptör tanımından).
- Sezgisel durum (hook'u olmayan ajanlar için): çıktı akışı + ekran kuralları motoru (AgentDeck'teki vt100 kural motorundan esinlenip veriye dayalı olarak yeniden yazılmış).
- Hub süpervizörü: hub'ı sidecar olarak başlatır, sağlığını izler, çökünce yeniden başlatır; port/token'ı okur.

### 2.2 Hub (`hub/`)
- `Hub.Core` (saf, test edilebilir; UI/OS bağımsız): oturum modeli, durum makinesi, kural motoru, kullanım toplayıcı, fiyat tablosu, todo parser, bekleme metrikleri, dikte metin işleme, adaptör sözleşmeleri.
- `Hub.Infrastructure`: SQLite (Dapper), migration'lar, ajan dosya okuyucuları, ayar dosyası birleştiriciler (yedekli), Whisper, git runner, model indirme.
- `Hub.Service`: ASP.NET Core minimal API (Kestrel, yalnızca 127.0.0.1) + WebSocket olay akışı, arka plan servisleri (transcript tarayıcı, saat, günlük özet).
- Platforma özel kod yok; gerekirse `IPlatform` arayüzü üzerinden desktop app'e sorar (ör. "bu oturumun terminali önde mi?").

### 2.3 Hook sidecar (`crates/hook`)
- `agenthub-hook --agent <id> --event <name>`: stdin'den ≤1 MB JSON okur, panel ortam değişkenleriyle zenginleştirir, hub'a POST eder (≤500 ms), hub yoksa spool klasörüne yazar; **her zaman exit 0**, stdout'a yazmaz.
- Native, bağımlılıksız, ~1–2 MB; Windows'ta `--agent` başına komut satırı kayıtlarına yazılır (Codex `commandWindows`, Copilot `powershell` alanları dahil).
- OpenCode için ek: küçük JS eklentisi (`adapters/opencode/plugin.ts`) aynı uç noktaya POST eder.

### 2.4 Paylaşılan şema (`crates/proto`, `hub/Hub.Contracts`)
- `HookEnvelope { v, agent, event, paneId?, workspaceId?, tsMs, payload }`.
- Hub API DTO'ları için tek kaynak: JSON Schema (`schema/*.json`) → Rust (`typify`/serde) ve C# (System.Text.Json kaynak üretici) tipleri; şema testi iki tarafta da çalışır.

## 3. Ajan adaptör modeli

Her ajan iki parçalı tanımlanır:

**(a) Tanım dosyası** – `adapters/<id>/adapter.json` (veri, iki süreç de okur):
```json
{
  "id": "codex",
  "displayName": "Codex CLI",
  "avatar": { "letter": "X", "bg": "#1d2a26", "ink": "#7fd8b4" },
  "detect": { "executables": ["codex.exe", "codex"], "nodeScripts": ["@openai/codex"] },
  "launch": { "command": "codex", "args": [] },
  "gracefulClose": [{ "keys": "Ctrl+C", "repeat": 2, "waitMs": 1500 }],
  "permissionKeys": { "allowOnce": "1", "alwaysAllow": "2", "deny": "3" },
  "screenRules": []
}
```

**(b) Hub sınıfı** – `IAgentAdapter` (C#):
```csharp
public interface IAgentAdapter
{
    string Id { get; }
    IHookInstaller? Hooks { get; }                 // config path, format, events, install/uninstall/state (backup-first)
    AgentEvent? Map(HookEnvelope envelope);       // raw event → normalized (SessionStarted, Working, WaitingPermission, …)
    IUsageSource? Usage { get; }                  // locate files/DB, incremental parse → UsageEntry (tokens, model, ts, project)
    ILimitSource? Limits { get; }                 // 5h / weekly / credits if exposed locally
    IHeadlessRunner? Headless { get; }            // `codex exec`, `claude -p`, … for assistant/summary/dictation cleanup
    ProjectResolver ProjectOf { get; }            // session → project root (cwd, encoded folder, project hash …)
}
```

Normalleştirilmiş durumlar (CCC `SessionState`'in genelleştirilmişi): `Working, WaitingPermission, WaitingInput, Done, Idle, Error, Stale, Ended`. Durum makinesi ajan-bağımsızdır; adaptör yalnızca olayları eşler.

Oturum kimliği: `(agent, sessionId)`; panel eşleşmesi `paneId` (ürün içinde başlatılanlar) veya süreç ağacı (dışarıda başlatılanlar, CCC `ProcessChain` mantığı).

## 3a. Genişletilebilirlik: özel ajanlar ve AI sağlayıcıları

**Adaptör arama sırası:** yerleşik (`adapters/<id>/`, ürünle gelir) → kullanıcı (`%APPDATA%\kotilo\adapters\<id>\adapter.json`). Kullanıcı adaptörü yalnızca veridir; hub tarafında **genel adaptör** (`GenericAdapter`) onu yorumlar: hook kurulumu yok, olaylar Agent Integration Protocol'den gelir, kullanım yalnızca protokolün `usage` olayından. Şema doğrulaması yapılır; geçersiz dosya ayarlar ekranında hata olarak gösterilir, uygulamayı durdurmaz.

**Agent Integration Protocol v1** (`docs/agent-protocol.md`, `schema/agent-protocol.v1.json`):
- Taşıma: `agenthub-hook --agent <id> --event <event> [--json <payload>]` ya da `POST http://127.0.0.1:<port>/v1/events` (port + token `port.json`'dan; hook sidecar bunu sarmalar).
- Olaylar: `session-start {sessionId, cwd}`, `working`, `waiting-permission {tool, command|path, risk?}`, `waiting-input {question?}`, `done`, `error {kind, message}`, `session-end`, `usage {model, inputTokens, outputTokens, cachedTokens?, costUsd?}`.
- Panel eşleşmesi: ürün içinde başlatılan ajan `AGENTHUB_PANE_ID` ortam değişkenini görür ve olaya ekler (hook sidecar bunu otomatik yapar).
- Geriye dönük uyum: `v` alanı; hub bilinmeyen alanları yok sayar.
- Yerleşik adaptörler de içte aynı normalleştirilmiş olay modeline dönüşür; protokol bunun dışa açık hâlidir.

**AI sağlayıcı soyutlaması** (asistan, günlük özet, dikte düzeltmesi):
```csharp
public interface IAiProvider
{
    string Id { get; }                                   // "cli:claude", "cli:codex", "openai-compatible:<name>"
    Task<AiResult> CompleteAsync(AiRequest request, CancellationToken ct);   // system + user text, model, timeout; streaming optional
}
```
- `CliAiProvider`: adaptörün `IHeadlessRunner`'ını kullanır (araçlar kapalı).
- `OpenAiCompatibleProvider`: `/v1/chat/completions`; temel adres, model, isteğe bağlı anahtar; anahtar platform kasasında (Windows Credential Manager / macOS Keychain, platform katmanı üzerinden), asla `settings.json`'da ya da log'da değil.
- Sağlayıcı seçimi özellik başına yapılabilir (ör. dikte düzeltmesi yerel model, özet CLI).

**Kod eklentisi yok (v1):** üçüncü taraf kod çalıştırılmaz; genişletme yalnızca veri (adapter.json) + protokol + HTTP uç noktası ile.

## 3b. Terminalde tıklanabilir dosya yolları

- xterm.js `registerLinkProvider` ile; desenler: `path:line[:col]`, `path(line,col)`, `path line N`, Windows ve posix yolları, workspace'e göre göreli yollar.
- Bağlantı yalnızca dosya workspace içinde **var olduğunda** etkinleşir (Rust tarafında `stat`, panel cwd + workspace köküne göre çözülür); dış yollar ve URL'ler mevcut web-links eklentisinde kalır.
- Tıklama → görüntüleyicide aç + satıra git (Monaco `revealLineInCenter`); Ctrl+tıklama → yan panelde aç.
- Ajanın değiştirdiği dosyalar (zaman akışı) ile aynı açma yolunu kullanır.

## 4. Veri

- **SQLite (hub):** CCC şeması temel alınır, her tabloya `agent` sütunu: `sessions`, `session_transitions`, `usage_entries`, `transcript_offsets`, `projects`, `customers`, `git_status`, `todo_snapshots`, `daily_summaries`, `personal_tasks`, `dictations`, `notification_log`. Migration'lar sıfırdan (001) başlar; CCC verisinden içe aktarma aracı ayrı.
- **Ayarlar:** `%APPDATA%\kotilo\settings.json` (UI tercihleri, Tauri) ve `%LOCALAPPDATA%\kotilo\hub\settings.json` (hub kuralları). Atomik yazma.
- **Diğer:** `models\` (Whisper), `spool\`, `logs\`, `port.json` (port + token, yalnızca kullanıcı ACL'i).
- **Gizlilik kuralı:** transcript/prompt içeriği hiçbir tabloya ve log'a yazılmaz; yalnızca sayılar ve metadata.

## 5. Süreçler arası iletişim

| Yön | Kanal | Not |
|---|---|---|
| Hook → hub | HTTP POST `127.0.0.1:<port>/v1/events` | Port `port.json`'dan; token başlığı; hub yoksa spool |
| Desktop ↔ hub | HTTP (sorgu/komut) + WebSocket (`/v1/stream`: oturum, kullanım, bildirim olayları) | Token Rust tarafında tutulur, webview'e verilmez |
| UI ↔ Rust | Tauri `invoke` + event; PTY baytları panel kanalında (16 ms toplu) | AgentDeck'ten aynen |
| Dış istemciler | Aynı HTTP API (salt okunur kapsamlar) | Command Palette uzantısı vb. |

## 6. Platform katmanı

İşletim sistemine özel her şey tek yerde, arayüz sözleşmesiyle:

| Yetenek | Windows (v1) | macOS (v2) | Nerede |
|---|---|---|---|
| PTY | ConPTY (`portable-pty`) | posix pty | Rust |
| Süreç ağacı / panel temizliği | Job Object, Toolhelp | process group, `libproc` | Rust |
| Metni odaktaki alana yazma | SendInput + pano (geri yüklemeli), UIPI kontrolü | CGEvent + NSPasteboard, Erişilebilirlik izni | Rust |
| Odak çalmayan kayıt göstergesi | WS_EX_NOACTIVATE pencere | NSPanel non-activating | Rust/Tauri pencere |
| Terminale / pencereye odaklanma | SetForegroundWindow yedekleriyle | AppleScript / AX | Rust |
| Mikrofon | WASAPI (NAudio) | AVAudioEngine | Hub (C#) – bkz. §10 |
| Global kısayol, tray, bildirim | Tauri eklentileri | Tauri eklentileri | Rust |
| Kod imzası / dağıtım | OV sertifikası, Velopack veya Tauri NSIS + updater, Store MSI/EXE | Developer ID + notarization, DMG | CI |

Kural: `#[cfg(windows)]` / `OperatingSystem.IsWindows()` yalnızca platform katmanı dosyalarında geçer; çekirdek kod platform tespiti yapmaz.

## 7. Depo yapısı (hedef)

```
kotilo/
  apps/desktop/            Tauri 2 app (AgentDeck'ten)
    src/                   React UI
    src-tauri/             Rust core + platform layer
  crates/
    hook/                  agenthub-hook sidecar
    proto/                 shared types (generated from schema/)
  hub/
    Hub.Core/  Hub.Infrastructure/  Hub.Service/  Hub.Contracts/
    tests/
  adapters/<id>/           adapter.json, fixtures/, (opencode) plugin.ts
  schema/                  JSON Schemas for hook envelope, hub API, agent protocol, adapter.json
  docs/                    user guide, decisions, manual tests
  PRD.md  DESIGN_SYSTEM.md  ARCHITECTURE.md  AGENTS.md
```

## 8. Aktarım planı

| Kaynak | Hedef | Yöntem |
|---|---|---|
| AgentDeck (yazarın önceki özel prototipi) | `apps/desktop`, `crates/hook`, `crates/proto` | Anlık görüntü (git geçmişi taşınmaz); yalnızca ürüne ait kod alındı, kapalı bir entegrasyona ait dosyalar, bağımlılıklar (`rusqlite`, `vt100`) ve belgeler çıkarıldı (D-002). Ekran kuralı motoru M3'te veriye dayalı olarak yeniden yazıldı. |
| CCC (Claude Control Center 0.8.0, yazarın önceki özel uygulaması) | `hub/` | `Ccc.Core` → `Hub.Core`, `Ccc.Infrastructure` → `Hub.Infrastructure`, ingest + servisler `Ccc.App/Hosting` → `Hub.Service` (WinUI'siz). Anlık görüntü olarak aktarıldı (D-001). WinUI ekranları React'e yeniden yazılır (M2). |
| CCC `Ccc.Hook` + AgentDeck `notify-cli` | `crates/hook` | Rust tarafında birleşir; CCC'nin spool ve süreç zinciri mantığı eklenir. |
| CCC `TextInjector`, `DictationOverlay`, `TerminalLocator` | Rust platform katmanı | Yeniden yazım (aynı davranış, aynı testler). |

Eski iki depo özel ve salt okunur arşiv olarak kalır.

## 9. Derleme, test, dağıtım

- **Araçlar:** .NET 10 SDK, Rust stable (MSVC hedefi), Node.js LTS + npm, Tauri CLI 2.
- **Testler:** Hub: xUnit + FluentAssertions (saf Core testleri, adaptör fixture'ları, geçici dizinde ayar birleştirme); Rust: `cargo test` (pty, hook, kurallar); UI: Vitest + Testing Library; uçtan uca: Playwright (Vite dev server'a karşı, sahte hub ile). **Testler kullanıcının gerçek ajan ayarlarına, masaüstüne (global tuş/pano) veya sesine dokunmaz.**
- **Paketleme:** Tauri bundler (NSIS, kullanıcı başına) + hub'ın self-contained tek dosya yayını sidecar olarak; hook sidecar'ı native. Güncelleme: Tauri updater (imzalı manifest). Store için MSI/EXE.
- **CI:** GitHub Actions – windows-latest (v1), macos-latest (v2 hazırlığı: derleme + birim test).

## 10. Açık mimari kararlar

1. **Dikte motoru:** (a) Hub'da kalır: Whisper.net (Mac'te CoreML/Metal runtime'ı var), mikrofon platform katmanından PCM akışıyla gelir; (b) Rust'a taşınır: `whisper-rs` + `cpal` (tek dil, platformlar arası mikrofon). Öneri: v1'de (a) – mevcut test edilmiş kod; M6'da yeniden değerlendirme.
2. **Hub dağıtımı:** self-contained .NET (~70 MB) mı, framework-dependent mi? Öneri: self-contained trimmed (kullanıcıdan .NET kurması istenmez).
3. **Hook sidecar dili:** Rust (öneri; küçük ve platformlar arası) vs CCC'nin AOT C# hook'u (39 ms ölçülmüş). Rust sürümü aynı ölçümle doğrulanacak.
4. **Ayarların sahibi:** tek `settings.json` (hub) + UI tercihleri ayrı mı? Öneri: ayrı (UI çökse de kurallar korunur).
