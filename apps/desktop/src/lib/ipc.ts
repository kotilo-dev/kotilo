/**
 * Tauri `invoke` için tipli sarmalayıcılar. Frontend Rust command'larını asla
 * doğrudan `@tauri-apps/api` üzerinden çağırmaz — hepsi bu dosyadan geçer (SPEC §5).
 *
 * Sözleşme kaynağı: `tasks/faz2-spec.md` §2–4 + §8 (Revizyon bölümü bağlayıcı).
 */
import { Channel, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { logWarn } from "./logging";

declare global {
  interface Window {
    /** Set by `ErrorBoundary` once a crash has been caught this session (faz7-spec §9.4). */
    __agenthubCrashed?: boolean;
  }
}

/**
 * (command, code) pairs that are expected/noisy and must NOT be logged (faz7-spec §9.5):
 * `fs_write_text/conflict` (the save-conflict flow), `pty_write|pty_resize|pty_kill/not_found`
 * (pane already gone — routine), `fs_stat/not_found` (existence probing).
 */
const EXEMPT_IPC_ERRORS: ReadonlySet<string> = new Set([
  "fs_write_text/conflict",
  "pty_write/not_found",
  "pty_resize/not_found",
  "pty_kill/not_found",
  "fs_stat/not_found",
]);

/**
 * Central IPC error logging (faz7-spec §9.5): every `invoke` call in THIS FILE goes through
 * here (the plugin's own `invoke` — used e.g. by `@tauri-apps/plugin-log` itself — never does).
 * On failure: `warn("[ipc] <command> failed: <code> <message>")`, arguments are never logged.
 * Rethrows the original, unmodified rejection — callers' error-handling is unchanged.
 */
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (e) {
    const appError = toAppError(e);
    if (!EXEMPT_IPC_ERRORS.has(`${command}/${appError.code}`)) {
      logWarn(`[ipc] ${command} failed: ${appError.code} ${appError.message}`);
    }
    throw e;
  }
}

/** `%APPDATA%\kotilo\state.json` içeriğinin tamamı (tek kaynak, bkz. persistence). */
export type PersistedState = Record<string, unknown>;

/**
 * Kalıcı durumu yükler. Dosya yoksa veya bozuksa Rust tarafı `{}` döner (ve bozuk
 * dosyanın bir `.corrupt` kopyasını tutar) — frontend bunu ayrım yapmadan varsayılanlarla
 * birleştirir.
 */
export async function loadState(): Promise<PersistedState> {
  const value = await invoke<PersistedState | null>("load_state");
  return value ?? {};
}

/**
 * Tek bir üst düzey `state.json` anahtarını (slice) atomik olarak yazar (faz2-spec §1, §8.2).
 * Backend üst düzey anahtarı **değiştirir** (derin merge yok) — çağıran her zaman slice'ın
 * tamamını gönderir. Eski `save_state` command'ı kaldırıldı; her store yalnızca kendi
 * slice'ını yazar (ör. `layoutStore` → `"layout"`, workspace modülü Rust tarafından → `"workspaces"`).
 */
/**
 * faz7-spec §9.4: while `window.__agenthubCrashed` is set (a crash was caught this session),
 * writes are skipped so a corrupt in-memory state can't clobber `state.json` on top of the
 * crash — EXCEPT the recovery screen's own "Reset layout and reload", which passes
 * `bypassCrashGuard: true` to write through the guard on purpose.
 */
export async function saveStateSlice(
  key: string,
  value: unknown,
  opts?: { bypassCrashGuard?: boolean },
): Promise<void> {
  if (typeof window !== "undefined" && window.__agenthubCrashed && !opts?.bypassCrashGuard) return;
  await invoke<void>("save_state_slice", { key, value });
}

/**
 * Terminal (faz4-spec §1). Backend `src-tauri/src/pty/mod.rs`.
 *
 * `onData` ham byte akışını (D2) taşır: Rust `Channel<InvokeResponseBody>` üzerinden
 * `InvokeResponseBody::Raw` gönderir → JS tarafında `onmessage` bir `ArrayBuffer` alır
 * (JSON sayı dizisi serileştirmesi yok; doğrudan `new Uint8Array(buf)` ile `xterm.write()`'a
 * verilir — bkz. tauri-2.12.0/src/ipc/channel.rs).
 */
export type ShellKind = "pwsh" | "powershell" | "cmd" | "gitbash" | "wsl" | "bash" | "zsh" | "fish";

export interface ShellProfile {
  id: ShellKind;
  name: string;
  /** Mutlak yol; asla canonicalize edilmemiş olmalı (faz4-spec §4.14, app-execution alias'ları). */
  program: string;
  args: string[];
}

/**
 * Yalnızca bu makinede bulunan profiller. Windows: pwsh, powershell, cmd, gitbash, wsl; macOS/Linux:
 * oturum kabuğu (`$SHELL`), sonra zsh, bash, fish, pwsh. İlki varsayılan.
 */
export async function ptyProfiles(): Promise<ShellProfile[]> {
  return invoke<ShellProfile[]>("pty_profiles");
}

export interface PtySpawnParams {
  workspaceId: string;
  /** "" = workspace kökü; fsguard ile çözülür, klasör olmalı. */
  cwdRel: string;
  /** `null` → varsayılan profil. */
  profileId: ShellKind | null;
  /** ör. "claude" — shell içinde çalıştırılır, çıkınca shell kalır (`null` → düz shell). */
  agentCommand: string | null;
  cols: number;
  rows: number;
  onData: Channel<ArrayBuffer>;
}

export interface PtySpawnResult {
  paneId: string;
  pid: number;
}

/** Yeni bir ConPTY pane başlatır. */
export async function ptySpawn(params: PtySpawnParams): Promise<PtySpawnResult> {
  return invoke<PtySpawnResult>("pty_spawn", {
    workspaceId: params.workspaceId,
    cwdRel: params.cwdRel,
    profileId: params.profileId,
    agentCommand: params.agentCommand,
    cols: params.cols,
    rows: params.rows,
    onData: params.onData,
  });
}

/** xterm'in `onData` çıktısını (kullanıcı tuş vuruşları) PTY'nin girişine yazar. */
export async function ptyWrite(paneId: string, data: string): Promise<void> {
  await invoke<void>("pty_write", { paneId, data });
}

/** xterm'in `onBinary` çıktısı (fare raporları vb.) — latin1 byte'lar. */
export async function ptyWriteBytes(paneId: string, data: number[]): Promise<void> {
  await invoke<void>("pty_write_bytes", { paneId, data });
}

/** Panel yeniden boyutlandığında ConPTY'ye haber verir; cols/rows 0 ise no-op (hata değil). */
export async function ptyResize(paneId: string, cols: number, rows: number): Promise<void> {
  await invoke<void>("pty_resize", { paneId, cols, rows });
}

/** Pane'i öldürür (Job Object kapanır → D8 gereği tüm alt süreç ağacı biter). Bilinmeyen pane → no-op. */
export async function ptyKill(paneId: string): Promise<void> {
  await invoke<void>("pty_kill", { paneId });
}

export interface PtyBusyResult {
  busy: boolean;
  /** Benzersiz süreç adları (`.exe` uzantısız, ör. `["claude", "node"]`). */
  processes: string[];
}

/** Kapanış onayı için: shell dışında hâlâ çalışan bir alt süreç var mı. */
export async function ptyBusy(paneId: string): Promise<PtyBusyResult> {
  return invoke<PtyBusyResult>("pty_busy", { paneId });
}

export interface PtyExitPayload {
  paneId: string;
  exitCode: number;
}

/** `pty_spawn` çözülmeden önce de gelebilir (faz4-spec §4.7) — çağıran `earlyExits` ile eşler. */
export function onPtyExit(handler: (payload: PtyExitPayload) => void): Promise<UnlistenFn> {
  return listen<PtyExitPayload>("pty:exit", (e) => handler(e.payload));
}

/** 0.3.2: the agent exited but processes it started still run under the pane's shell; `[]` = cleared. */
export interface PtyLeftoverPayload {
  paneId: string;
  processes: string[];
}

export function onPtyLeftover(handler: (payload: PtyLeftoverPayload) => void): Promise<UnlistenFn> {
  return listen<PtyLeftoverPayload>("pty:leftover", (e) => handler(e.payload));
}

/** Terminates the shell's descendants (not the shell) of a pane with leftovers. */
export async function ptyStopLeftovers(paneId: string): Promise<void> {
  await invoke<void>("pty_stop_leftovers", { paneId });
}

/** D8 derisk: pane'in Job Object'indeki PID listesi (isim ile, cmdline opsiyonel). Faz 5 için korunur. */
export interface PtyProcessInfo {
  pid: number;
  name: string | null;
  cmdline: string | null;
}

export async function ptyProcesses(paneId: string): Promise<PtyProcessInfo[]> {
  return invoke<PtyProcessInfo[]>("pty_processes", { paneId });
}

export { Channel };

// ---------------------------------------------------------------------------
// Faz 2 — Workspaces & dosya ağacı (faz2-spec.md §2–4, §8)
// ---------------------------------------------------------------------------

/**
 * Backend'in döndürebileceği hata kodları (faz2-spec §2, §8.1: snake_case).
 * `binary_file` / `too_large` / `conflict`: faz3-spec §1, §5.1.
 */
export type ErrorCode =
  | "not_found"
  | "outside_workspace"
  | "invalid_name"
  | "already_exists"
  | "duplicate_workspace"
  | "not_a_directory"
  | "no_image"
  | "io"
  | "binary_file"
  | "too_large"
  | "conflict"
  | "spawn_failed"
  | "invalid_json"
  | "invalid_argument"
  | "hub_unavailable";

/** Tüm command'ların reddettiği hata şekli — Tauri, invoke'u bu objenin kendisiyle reddeder. */
export interface AppError {
  code: ErrorCode;
  message: string;
  /** Per-field messages of a hub validation error, keyed by field path (`"rules.minTurnForCompleted"`). */
  fields?: Record<string, string[]>;
}

/** `catch (e)` içinde `e`'nin `AppError` olup olmadığını (ve isteğe bağlı kodunu) daraltır. */
export function isAppError(e: unknown, code?: ErrorCode): e is AppError {
  if (typeof e !== "object" || e === null) return false;
  const candidate = e as Partial<AppError>;
  if (typeof candidate.code !== "string" || typeof candidate.message !== "string") return false;
  return code === undefined || candidate.code === code;
}

/** Rastgele şekilli bir catch değerini her zaman bir `AppError`'a çevirir (ör. beklenmeyen atmalar). */
export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  return { code: "io", message: e instanceof Error ? e.message : String(e) };
}

/** Dizi sırası = görünüm sırası (workspace kökleri). */
export interface Workspace {
  id: string;
  name: string;
  /** `dunce::canonicalize` çıktısı (faz2-spec §8.4) — gösterim ve "Yolu kopyala" bunu kullanır. */
  path: string;
  expandedDirs: string[];
}

export interface WorkspacesState {
  workspaces: Workspace[];
  activeId: string | null;
}

/** Sıralı: klasör önce, case-insensitive ad (backend garantisi). */
export interface DirEntry {
  name: string;
  rel: string;
  isDir: boolean;
}

/**
 * Faz 6 §3/§4: `fs_search` + `subsequence_score`'un yerini alır (nucleo-matcher tabanlı).
 * `indices` = `rel`'deki eşleşen **Unicode scalar** indeksleri (`Array.from(rel)` ile eşleşir).
 */
export interface QuickOpenItem {
  rel: string;
  score: number;
  indices: number[];
}

export interface QuickOpenResult {
  items: QuickOpenItem[];
  /** İndeks 200 000 dosya sınırına takıldı — sonuçlar eksik olabilir. */
  truncated: boolean;
}

/** Boş `query` → `{ items: [], truncated: false }`. `limit` ≤ 200. */
export async function fsQuickOpen(workspaceId: string, query: string, limit: number): Promise<QuickOpenResult> {
  return invoke<QuickOpenResult>("fs_quick_open", { workspaceId, query, limit });
}

export async function workspaceList(): Promise<WorkspacesState> {
  return invoke<WorkspacesState>("workspace_list");
}

/** Canonical path ile duplicate → `duplicate_workspace`; klasör değilse `not_a_directory`. */
export async function workspaceAdd(path: string): Promise<Workspace> {
  return invoke<Workspace>("workspace_add", { path });
}

/** Diskten silmez; watcher durur; aktifse aktif = ilk kalan / null. */
export async function workspaceRemove(id: string): Promise<void> {
  await invoke<void>("workspace_remove", { id });
}

/** Yalnızca görünen ad (boş → `invalid_name`). */
export async function workspaceRename(id: string, name: string): Promise<void> {
  await invoke<void>("workspace_rename", { id, name });
}

/** `ids` mevcut kümenin permütasyonu olmalı. */
export async function workspaceReorder(ids: string[]): Promise<void> {
  await invoke<void>("workspace_reorder", { ids });
}

export async function workspaceSetActive(id: string): Promise<void> {
  await invoke<void>("workspace_set_active", { id });
}

/**
 * Kalıcı yazar ama `workspaces:changed` yayınlamaz (faz2-spec §8.3) — frontend `expanded`
 * durumunu kendi state'inde tutar, bu yalnızca kalıcılık için "ateşle-unut" bir çağrıdır.
 * Bilinmeyen id → sessizce `Ok`.
 */
export async function workspaceSetExpanded(id: string, dirs: string[]): Promise<void> {
  await invoke<void>("workspace_set_expanded", { id, dirs });
}

export async function fsReadDir(workspaceId: string, rel: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("fs_read_dir", { workspaceId, rel });
}

/** Yeni `rel` döner; varsa `already_exists`. */
export async function fsCreateFile(workspaceId: string, dirRel: string, name: string): Promise<string> {
  return invoke<string>("fs_create_file", { workspaceId, dirRel, name });
}

export async function fsCreateDir(workspaceId: string, dirRel: string, name: string): Promise<string> {
  return invoke<string>("fs_create_dir", { workspaceId, dirRel, name });
}

/** Aynı klasörde yeniden adlandırma; yeni `rel` döner. */
export async function fsRename(workspaceId: string, rel: string, newName: string): Promise<string> {
  return invoke<string>("fs_rename", { workspaceId, rel, newName });
}

/** Geri Dönüşüm Kutusu'na taşır (D9); `rel=""` (kök) → `invalid_name`. */
export async function fsDelete(workspaceId: string, rel: string): Promise<void> {
  await invoke<void>("fs_delete", { workspaceId, rel });
}

/** Explorer'da seçili göster; `rel=""` → klasörü aç. */
export async function fsReveal(workspaceId: string, rel: string): Promise<void> {
  await invoke<void>("fs_reveal", { workspaceId, rel });
}

/** D22; `rel` döner; panoda görsel yoksa `no_image`. */
export async function clipboardSaveImage(workspaceId: string, dirRel: string): Promise<string> {
  return invoke<string>("clipboard_save_image", { workspaceId, dirRel });
}

export async function clipboardWriteText(text: string): Promise<void> {
  await invoke<void>("clipboard_write_text", { text });
}

// --- Event payload'ları + dinleyici yardımcıları (faz2-spec §4) -----------------------------

/** Değişen dosya/klasörlerin ebeveyn klasörlerinin rel'i (tekilleştirilmiş). Kök değişince `[""]`. */
export interface FsChangedPayload {
  workspaceId: string;
  dirs: string[];
}

/** Watcher hata/taşma; frontend o workspace'in yüklü tüm klasörlerini yeniler. */
export interface FsRescanPayload {
  workspaceId: string;
}

export function onFsChanged(handler: (payload: FsChangedPayload) => void): Promise<UnlistenFn> {
  return listen<FsChangedPayload>("fs:changed", (e) => handler(e.payload));
}

export function onFsRescan(handler: (payload: FsRescanPayload) => void): Promise<UnlistenFn> {
  return listen<FsRescanPayload>("fs:rescan", (e) => handler(e.payload));
}

/** Tek kaynak: workspace listesi/aktifId yalnızca bu event ile güncellenir (optimistic update yok). */
export function onWorkspacesChanged(handler: (payload: WorkspacesState) => void): Promise<UnlistenFn> {
  return listen<WorkspacesState>("workspaces:changed", (e) => handler(e.payload));
}

// ---------------------------------------------------------------------------
// Faz 3 — Viewer: metin dosyaları, encoding/EOL, adfs protokolü (faz3-spec.md §1, §5)
// ---------------------------------------------------------------------------

/** `ansi` = sistemin ANSI kod sayfası (`GetACP()`, TR'de windows-1254). */
export type TextEncoding = "utf8" | "utf8bom" | "utf16le" | "utf16be" | "ansi";
export type Eol = "lf" | "crlf";

export interface TextFile {
  text: string;
  encoding: TextEncoding;
  eol: Eol;
  mixedEol: boolean;
  hash: string;
  mtimeMs: number;
  size: number;
  readOnly: boolean;
  /** `readOnly` nedeni (değilse `null`): 5 MB üstü ya da kayıpsız yazılamayan (lossy) decode. */
  readOnlyReason: ReadOnlyReason | null;
}

export type ReadOnlyReason = "too_large" | "lossy_encoding";

/** §5.4: `hash` her zaman dolu (boyut sınırı yok — Faz 2'deki gibi `null` değil). */
export interface FileStat {
  size: number;
  mtimeMs: number;
  hash: string;
}

export interface WriteResult {
  hash: string;
  mtimeMs: number;
}

/** Binary → `binary_file`; > 50 MB → `too_large`; > 5 MB veya lossy decode → `readOnly=true` (+ `readOnlyReason`). */
export async function fsReadText(workspaceId: string, rel: string): Promise<TextFile> {
  return invoke<TextFile>("fs_read_text", { workspaceId, rel });
}

/**
 * `expectedHash` verilmişse ve diskteki hash farklıysa → `conflict` (yazmaz).
 * `null` verilirse (yeni dosya / conflict kontrolü istenmiyorsa) koşulsuz yazar.
 */
export async function fsWriteText(
  workspaceId: string,
  rel: string,
  text: string,
  encoding: TextEncoding,
  eol: Eol,
  expectedHash: string | null,
): Promise<WriteResult> {
  return invoke<WriteResult>("fs_write_text", { workspaceId, rel, text, encoding, eol, expectedHash });
}

export async function fsStat(workspaceId: string, rel: string): Promise<FileStat> {
  return invoke<FileStat>("fs_stat", { workspaceId, rel });
}

/** `tauri::ipc::Response` (ham byte, JSON değil) → doğrudan `ArrayBuffer`; > 100 MB → `too_large`. */
export async function fsReadBytes(workspaceId: string, rel: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("fs_read_bytes", { workspaceId, rel });
}

/** `tauri-plugin-opener` `open_path` ile varsayılan uygulamada açar (Unsupported view). */
export async function fsOpenDefault(workspaceId: string, rel: string): Promise<void> {
  await invoke<void>("fs_open_default", { workspaceId, rel });
}

/** `true` yalnızca var olan bir **dosya** için (dizin ya da eksik → `false`). */
export async function fsExists(workspaceId: string, rel: string): Promise<boolean> {
  return invoke<boolean>("fs_exists", { workspaceId, rel });
}

/** Klasör seçici (Add workspace) — sahipsiz diyalog, bkz. `commands/dialog.rs`. İptal → `[]`. */
export async function pickFolders(title: string): Promise<string[]> {
  return invoke<string[]>("pick_folders", { title });
}

/** §5.7: yalnızca `http://`/`https://` — aksi `invalid_name`. Markdown önizlemesindeki dış linkler. */
export async function openExternalUrl(url: string): Promise<void> {
  await invoke<void>("open_external_url", { url });
}

/**
 * `adfs` özel protokolünün Windows üzerindeki HTTP görünümü (§1 D4, §5.13):
 * `http://adfs.localhost/<workspaceId>/<rel>`. Her segment ayrı ayrı `encodeURIComponent`
 * ile kodlanır (`#`, `?`, `%`, Türkçe karakterler dahil, §5.20) — `/` segment ayracı korunur.
 */
export function adfsUrl(workspaceId: string, rel: string): string {
  const segments = rel === "" ? [] : rel.split("/").map((segment) => encodeURIComponent(segment));
  return `http://adfs.localhost/${encodeURIComponent(workspaceId)}/${segments.join("/")}`;
}

// ---------------------------------------------------------------------------
// Faz 4 — Terminal: dosya yolu linkleri + pano metni + sürüm bilgisi (faz4-spec.md §1.3–1.4, §4.21)
// ---------------------------------------------------------------------------

export interface ResolvedLink {
  rel: string;
  line: number | null;
  column: number | null;
}

/**
 * Terminaldeki bir yol adayını çözer. Göreli yol önce `baseRel`e, sonra workspace köküne göre
 * denenir; sonuç mevcut bir dosya değilse ya da workspace dışındaysa `null` (hata değil).
 */
export async function fsResolveLink(
  workspaceId: string,
  baseRel: string,
  candidate: string,
): Promise<ResolvedLink | null> {
  return invoke<ResolvedLink | null>("fs_resolve_link", { workspaceId, baseRel, candidate });
}

/** `arboard` — metin yoksa `null`. WebView2 `navigator.clipboard` izin/odak sorunlarından kaçınmak için. */
export async function clipboardReadText(): Promise<string | null> {
  return invoke<string | null>("clipboard_read_text");
}

/**
 * faz7-spec §9.7: `app_info` was EXTENDED, not changed — `osBuild` keeps its original meaning
 * (ConPTY reflow/cursor heuristics); `version`/`gitSha`/`webview2`/`os` are faz7's About section.
 */
export interface AppInfo {
  osBuild: number;
  version: string;
  gitSha: string;
  webview2: string;
  os: string;
  /** faz7-spec §11: UTC date (`YYYY-MM-DD`) from `build.rs`'s `AGENTHUB_BUILD_DATE`. */
  buildDate: string;
  /** U-2: `"windows"`, `"macos"` or `"linux"` (missing from an older backend). */
  platform?: string;
  /** U-2: OS-dependent features that exist here; see `lib/platform.ts`. */
  features?: PlatformFeatures;
}

/** U-2: features that need OS code which exists only on some systems (all Windows-only today). */
export interface PlatformFeatures {
  /** System-wide shortcuts (dictation, assistant). */
  globalHotkeys: boolean;
  /** Dictation: overlay and typing the text into the focused window. */
  dictation: boolean;
  mascot: boolean;
  /** The "while you were away" summary. */
  awaySummary: boolean;
  bundledConpty: boolean;
  windowsTerminalSchemes: boolean;
  /** D-065: blurring what shows through a translucent window. */
  windowAcrylic: boolean;
}

/** ConPTY'ye özel yeniden akış/imleç sezgileri için Windows build numarası + About bölümü verisi. */
export async function appInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

/** D-055: an installed Nerd Font family (Windows Terminal's choice first) for the default terminal font, or null. */
export async function terminalFontSuggestion(): Promise<string | null> {
  return invoke<string | null>("terminal_font_suggestion");
}

/** D-057: colour schemes found in Windows Terminal's settings (read only; empty when none). */
export async function terminalWtSchemes(): Promise<TerminalScheme[]> {
  return invoke<TerminalScheme[]>("terminal_wt_schemes");
}

// ---------------------------------------------------------------------------
// M5 — Updater (tauri-plugin-updater behind the app's own commands, D-047)
// ---------------------------------------------------------------------------

/** `not-configured`: the build has no updater endpoint/key (dev builds, forks). */
export type UpdateCheckResult =
  | { status: "not-configured" }
  | { status: "up-to-date"; current: string }
  | { status: "available"; current: string; version: string; notes: string | null; date: string | null }
  | { status: "error"; message: string };

export interface UpdateProgress {
  downloaded: number;
  /** `null` when the server sent no content length. */
  total: number | null;
}

export async function updateCheck(): Promise<UpdateCheckResult> {
  return invoke<UpdateCheckResult>("update_check");
}

/** Downloads + installs the update found by the last check; the app restarts afterwards. Rejects with a message string. */
export async function updateInstall(): Promise<void> {
  await invoke<void>("update_install");
}

export function onUpdateProgress(handler: (progress: UpdateProgress) => void): Promise<UnlistenFn> {
  return listen<UpdateProgress>("update://progress", (e) => handler(e.payload));
}

/** The download finished and the installer runs; the app restarts next. */
export function onUpdateReady(handler: () => void): Promise<UnlistenFn> {
  return listen<unknown>("update://ready", () => handler());
}

// ---------------------------------------------------------------------------
// Faz 7 — Diagnostics: log level, collect diagnostics zip (faz7-spec.md §4, §9.6–§9.7)
// ---------------------------------------------------------------------------

export interface DiagnosticsCollectResult {
  /** Absolute path to the written `kotilo-diagnostics-<yyyyMMdd-HHmmss>.zip`. */
  path: string;
}

/** Backend already reveals the zip in Explorer; this just returns the path to copy/display. */
export async function diagnosticsCollect(): Promise<DiagnosticsCollectResult> {
  return invoke<DiagnosticsCollectResult>("diagnostics_collect");
}

/** Opens `%LOCALAPPDATA%\kotilo\logs` in Explorer. */
export async function diagnosticsOpenLogs(): Promise<void> {
  await invoke<void>("diagnostics_open_logs");
}

// ---------------------------------------------------------------------------
// Faz 5 — Agent takibi (faz5-spec.md §1.6, §2)
// ---------------------------------------------------------------------------

/** Coarse kind kept for the current UI; M3 wave 3 moves to `Agent.adapterId`. `custom` = a user adapter. */
export type AgentKind =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "copilot"
  | "qwen"
  | "droid"
  | "cursor"
  | "custom"
  | "other";
export type AgentState = "blocked" | "working" | "done" | "idle";
export type AgentSource = "hook" | "heuristic";

export interface Agent {
  id: string;
  paneId: string;
  workspaceId: string;
  kind: AgentKind;
  /** M3: the agent's adapter id (`claude-code`, `codex`, a user adapter id); always sent by Rust, `null` when unknown. */
  adapterId?: string | null;
  state: AgentState;
  sinceMs: number;
  source: AgentSource;
  /** The agent's own session id from its last hook; `null` for heuristic records (M2: hub session lookup). */
  sessionId: string | null;
  /** 0.3.2: background work the agent waits for after its turn (e.g. a subagent name); empty when none. */
  backgroundTasks?: string[];
  /** `blocked` on a multiple-choice question (Claude's AskUserQuestion/ExitPlanMode), not a yes/no permission. */
  questionPending?: boolean;
}

export async function agentsList(): Promise<Agent[]> {
  return invoke<Agent[]>("agents_list");
}

/** `done → idle`; bilinmeyen pane → no-op. */
export async function agentAck(paneId: string): Promise<void> {
  await invoke<void>("agent_ack", { paneId });
}

/** Frontend her görünür-terminal değişiminde ve pencere odak değişiminde çağırır (debounce 100 ms, yalnızca frontend'de). */
export async function agentSetFocus(visiblePaneId: string | null, windowFocused: boolean): Promise<void> {
  await invoke<void>("agent_set_focus", { visiblePaneId, windowFocused });
}

export function onAgentsChanged(handler: (agents: Agent[]) => void): Promise<UnlistenFn> {
  return listen<Agent[]>("agents:changed", (e) => handler(e.payload));
}

// ---------------------------------------------------------------------------
// M3 — adapter definitions (adapter.json v1, built-in + user)
// ---------------------------------------------------------------------------

export type ScreenRuleState = "waitingPermission" | "waitingInput" | "working" | "done";

export interface ScreenRule {
  id: string;
  state: ScreenRuleState;
  /** Regex over the last `lines` (default 6) non-blank visible screen lines joined by "\n". */
  pattern: string;
  lines?: number;
  clearOn?: "output" | "input";
}

/** Key notation (`adapters::keys`): `Esc`, `Enter`, `Right`, `Ctrl+C`, `1`, `y`, `Down Enter`, literal text. */
export interface AdapterDefinition {
  v: number;
  id: string;
  displayName: string;
  avatar: { letter: string; bg: string; ink: string } | null;
  detect: { executables: string[]; nodeScripts: string[] };
  /** D-067: `resumeArgs` resume a session (`{sessionId}` is replaced); absent = no resume. */
  launch: { command: string; args: string[]; resumeArgs?: string[] } | null;
  gracefulClose: { keys: string; repeat?: number; gapMs?: number; waitMs?: number }[];
  permissionKeys: { allowOnce?: string; alwaysAllow?: string; deny?: string } | null;
  hooks?: { shell?: string; events?: string[] };
  usage?: string;
  screenRules: ScreenRule[];
  source: "builtIn" | "user";
}

export interface AdapterDefinitionError {
  /** The file's id, or its folder name when the file has none. */
  id: string;
  path: string;
  source: "builtIn" | "user";
  message: string;
}

export interface AdapterDefinitions {
  definitions: AdapterDefinition[];
  errors: AdapterDefinitionError[];
}

export async function agentsDefinitions(): Promise<AdapterDefinitions> {
  return invoke<AdapterDefinitions>("agents_definitions");
}

/** Re-reads every adapter.json (after a user adapter was added or edited). */
export async function agentsDefinitionsReload(): Promise<AdapterDefinitions> {
  return invoke<AdapterDefinitions>("agents_definitions_reload");
}

/** Ids of the loaded definitions whose `detect.executables` are on PATH (the launch menu offers these). */
export async function agentsInstalled(): Promise<string[]> {
  return invoke<string[]>("agents_installed");
}

/** What the wizard writes: `adapter.json` v1 without the loader's `source`. */
export type UserAdapterDefinition = Omit<AdapterDefinition, "source">;

/**
 * Writes `%APPDATA%\kotilo\adapters\<id>\adapter.json` (validated like the loader) and
 * reloads the definitions. Errors: `invalid_argument` (invalid or built-in id),
 * `already_exists` (without `overwrite`), `io`.
 */
export async function agentsSaveUserDefinition(definition: UserAdapterDefinition, overwrite: boolean): Promise<AdapterDefinitions> {
  return invoke<AdapterDefinitions>("agents_save_user_definition", { definition, overwrite });
}

/** Deletes a user adapter file and reloads. Errors: `invalid_argument`, `not_found`, `io`. */
export async function agentsDeleteUserDefinition(id: string): Promise<AdapterDefinitions> {
  return invoke<AdapterDefinitions>("agents_delete_user_definition", { id });
}

/** Sends a key sequence (adapter key notation) to a pane, e.g. a definition's `permissionKeys.allowOnce`. */
export async function paneSendKeys(paneId: string, keys: string): Promise<void> {
  await invoke<void>("pane_send_keys", { paneId, keys });
}

/** M1: the hub owns agent hook integration; `hubAvailable=false` means its background service is not reachable. */
export interface HooksStatus {
  hubAvailable: boolean;
  installed: boolean;
  upToDate: boolean;
  /** `missing | installed | outdated | invalidConfig | unsupported`, `null` when the hub is unavailable. */
  state: string | null;
  settingsPath: string | null;
}

export async function hooksStatus(): Promise<HooksStatus> {
  return invoke<HooksStatus>("hooks_status");
}

/** Hata kodları: `hub_unavailable`, `invalid_json` (bozuk settings.json, dokunulmadı), `not_found`, `io`. */
export async function hooksInstall(adapterId?: string): Promise<void> {
  await invoke<void>("hooks_install", adapterId ? { adapterId } : undefined);
}

export async function hooksUninstall(adapterId?: string): Promise<void> {
  await invoke<void>("hooks_uninstall", adapterId ? { adapterId } : undefined);
}

// ---------------------------------------------------------------------------
// Faz 6 — Ayarlar, git branch (faz6-spec.md §1–3, §10 revizyonu bağlayıcı)
// ---------------------------------------------------------------------------

export type ThemeName = "dark" | "light" | "system";

/**
 * D-057: a terminal colour scheme as stored in settings (copied from Windows Terminal on
 * import). Colours are `#rrggbb`.
 */
export interface TerminalScheme {
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface Settings {
  v: 1;
  /** Mode: which of `appearance.darkTheme` / `appearance.lightTheme` applies. */
  theme: ThemeName;
  /** D-057: colour theme ids (built-in catalogue in `app/theme`); unknown ids fall back to Kotilo. */
  /** D-065: `windowOpacity` is the background's opacity in percent (30–100, text stays opaque). */
  appearance: { darkTheme: string; lightTheme: string; windowOpacity: number; acrylic: boolean };
  editor: { fontFamily: string; fontSize: number };
  terminal: {
    fontFamily: string;
    fontSize: number;
    /** §10.2: yalnızca frontend'de kullanılır — Rust `SettingsStore` bunu okumaz. */
    defaultShell: ShellKind | null;
    copyOnSelect: boolean;
    warnMultilinePaste: boolean;
    /** D-068: programs may set the clipboard with OSC 52 (writes only). */
    osc52Clipboard: boolean;
    /** D-055: Microsoft's bundled ConPTY (sixel images); read by Rust at startup. */
    bundledConpty: boolean;
    /** D-057: "app" (follow the app theme), a built-in theme id, or "imported:<name>". */
    colorScheme: string;
    /** D-057: schemes copied from Windows Terminal (read-only import). */
    importedSchemes: TerminalScheme[];
  };
  agents: {
    commands: string[];
    notifications: boolean;
    /** D-056: one "while you were away" toast when input resumes after `awaySummaryMinutes`. */
    awaySummary: boolean;
    awaySummaryMinutes: number;
  };
  files: { hiddenPatterns: string[]; respectGitignore: boolean };
  clipboard: { copyPathAfterImageSave: boolean };
  /** faz7-spec §5/§6: `false` by default; backend applies the resulting log level itself. */
  diagnostics: { verboseLogging: boolean };
  /**
   * M4 composer: user-authored saved prompts (an explicit rule-5 exception, kept out of
   * diagnostics) and the one-time `.kotilo/` gitignore hint. Optional for older fixtures.
   */
  composer?: ComposerSettings;
  /**
   * M5: frontend-only; Rust keeps it through its `extra` map. Missing (older settings.json)
   * means the default: check on start.
   */
  updates?: { checkOnStart: boolean };
  /** D-058: frontend-only like `updates`; missing means off. */
  window?: { closeToTray: boolean };
}

export interface SavedPrompt {
  id: string;
  title: string;
  text: string;
}

export interface ComposerSettings {
  savedPrompts: SavedPrompt[];
  attachmentsHintShown: boolean;
}

export async function settingsGet(): Promise<Settings> {
  return invoke<Settings>("settings_get");
}

/** Tam değiştirme; doğrulanmış/normalize edilmiş hali döner. Geçersiz kalıp → `invalid_argument`. */
export async function settingsSet(settings: Settings): Promise<Settings> {
  return invoke<Settings>("settings_set", { settings });
}

export type GitHead = { kind: "branch"; name: string } | { kind: "detached"; sha: string };

/** Repo yoksa/okunamazsa `null` (hata değil). */
export async function gitHead(workspaceId: string): Promise<GitHead | null> {
  return invoke<GitHead | null>("git_head", { workspaceId });
}

// M4 — changed files (git CLI). Paths are workspace-relative with `/` separators (equal to
// repo-relative when the workspace is the repo root; changes outside a subfolder workspace
// are left out).

export type GitFileStatus = "M" | "A" | "D" | "R" | "?";

export interface GitChangedFile {
  path: string;
  status: GitFileStatus;
  /** `null` for binary files; for untracked files also when ≥ 1 MB or not counted. */
  added: number | null;
  removed: number | null;
  /** Only for `R`, and only when the old path is inside the workspace. */
  oldPath?: string;
}

export interface GitChanges {
  /** `false` when the workspace is not in a repo or git is not on PATH. */
  repo: boolean;
  /** Full commit id of HEAD; `null` before the first commit. */
  head: string | null;
  /** Sorted by path. */
  files: GitChangedFile[];
  /** More than 5000 changes; the rest are left out. */
  truncated: boolean;
}

/** Working copy vs HEAD. Never rejects for "no git / not a repo / no commit"; only for an unknown workspace. */
export async function gitChanges(workspaceId: string): Promise<GitChanges> {
  return invoke<GitChanges>("git_changes", { workspaceId });
}

export interface GitHeadContent {
  /** Decoded and LF-normalized like `fsReadText`; `null` when not in HEAD, binary, too large or no repo. */
  content: string | null;
  binary: boolean;
  /** Blob above 2 MB. */
  tooLarge: boolean;
}

/** A file's HEAD version for the diff view. `..`/absolute paths reject with `outside_workspace`. */
export async function gitShowHead(workspaceId: string, path: string): Promise<GitHeadContent> {
  return invoke<GitHeadContent>("git_show_head", { workspaceId, path });
}

// ---------------------------------------------------------------------------
// M2 — hub (background service). The token stays in Rust; the webview only names paths.
// ---------------------------------------------------------------------------

export type HubMethod = "GET" | "POST" | "PUT" | "DELETE";

/** A hub REST call (`/v1/...` only). Errors: `hub_unavailable`, `not_found`, `invalid_argument` (validation message), `io`. */
export async function hubRequest<T>(method: HubMethod, path: string, body?: unknown): Promise<T> {
  return invoke<T>("hub_request", { method, path, body: body ?? null });
}

/** Saves a hub download (report export) to `dest`, chosen by the user in a save dialog. */
export async function hubExport(path: string, dest: string): Promise<void> {
  await invoke<void>("hub_export", { path, dest });
}

/** The supervisor's view of the background service process. */
export type HubProcessStatus =
  | { state: "stopped" }
  | { state: "notFound" }
  | { state: "running"; pid: number }
  | { state: "external" }
  | { state: "restarting"; restarts: number };

export async function hubStatus(): Promise<HubProcessStatus> {
  return invoke<HubProcessStatus>("hub_status");
}

/** `app:quit-requested` — the macOS app menu's Quit while "keep running in the tray" is on (U-3). */
export function onQuitRequested(handler: () => void): Promise<UnlistenFn> {
  return listen("app:quit-requested", () => handler());
}

/** `hub:status` — whether the `/v1/stream` WebSocket is connected. */
export function onHubStatus(handler: (status: { connected: boolean }) => void): Promise<UnlistenFn> {
  return listen<{ connected: boolean }>("hub:status", (e) => handler(e.payload));
}

/** `hub:event` — one `/v1/stream` frame (see `hubTypes.ts` `StreamMessage`). */
export function onHubEvent(handler: (message: import("./hubTypes").StreamMessage) => void): Promise<UnlistenFn> {
  return listen<import("./hubTypes").StreamMessage>("hub:event", (e) => handler(e.payload));
}

// ---------------------------------------------------------------------------
// M2b — live dictation. Rust owns the hotkeys, microphone, overlay window and text insertion;
// the hub transcribes. The overlay window (`?view=dictation-overlay`) only renders these events.
// ---------------------------------------------------------------------------

export type DictationPhase = "hidden" | "recording" | "transcribing" | "cleaning" | "result";

/** Hold-to-talk vs tap-to-toggle, decided 350 ms after the hotkey press. */
export type DictationHoldMode = "undecided" | "hold" | "toggle";

export type DictationMessage =
  | "inserted"
  | "done"
  | "cancelled"
  | "noSpeech"
  | "silent"
  | "noMicrophone"
  | "modelMissing"
  | "cleanupFailed"
  | "elevatedTarget"
  | "noTarget"
  | "fileFailed"
  | "hubUnavailable"
  | "failed";

export type DictationSound = "start" | "stop" | "error";

/** `dictation:overlay` payload. */
export interface DictationOverlayState {
  phase: DictationPhase;
  mode: DictationHoldMode;
  elapsedMs: number;
  /** Microphone RMS of the latest buffer, 0..1. */
  level: number;
  /** `detail`: the underlying error text for `failed` / `fileFailed`. */
  result: { ok: boolean; message: DictationMessage; detail?: string | null } | null;
  /** A cue to play once with this event (when sound cues are on). */
  sound: DictationSound | null;
}

export interface DictationHotkeyStatus {
  gesture: string;
  /** Null when registered. */
  error: null | "invalid" | "taken";
}

export interface DictationStatus {
  enabled: boolean;
  hotkey: DictationHotkeyStatus;
  pasteLastHotkey: DictationHotkeyStatus;
  phase: DictationPhase;
}

/** Re-reads the hub's dictation settings and re-registers the hotkeys. */
export async function dictationReload(): Promise<void> {
  await invoke<void>("dictation_reload");
}

/** Cancels the dictation in progress (overlay ✕). */
export async function dictationCancel(): Promise<void> {
  await invoke<void>("dictation_cancel");
}

export async function dictationStatus(): Promise<DictationStatus> {
  return invoke<DictationStatus>("dictation_status");
}

export function onDictationOverlay(handler: (state: DictationOverlayState) => void): Promise<UnlistenFn> {
  return listen<DictationOverlayState>("dictation:overlay", (e) => handler(e.payload));
}

/** A dictation finished and was saved (`id` null when history is off). */
export function onDictationDone(handler: (payload: { id: number | null }) => void): Promise<UnlistenFn> {
  return listen<{ id: number | null }>("dictation:done", (e) => handler(e.payload));
}

/**
 * `dictation:composer` payload (M4): exactly one per composer dictation – the text, or why
 * there is none (`cancelled`, `silent`, `noSpeech`, `failed` with detail `"busy"`, ...).
 */
export type DictationComposerResult =
  | { paneId: string; text: string; cleaned: boolean }
  | { paneId: string; error: DictationMessage; detail?: string };

/**
 * Starts a composer dictation for `paneId` (same overlay, microphone, transcription and
 * cleanup as the hotkey; tap-to-toggle). The text arrives as `dictation:composer`, never
 * inserted through the OS. While another dictation runs, the answer is `failed`/`busy`.
 */
export async function dictationStartComposer(paneId: string): Promise<void> {
  await invoke<void>("dictation_start_composer", { paneId });
}

/** Stops the composer recording and transcribes it (no-op for a hotkey dictation). */
export async function dictationStopComposer(): Promise<void> {
  await invoke<void>("dictation_stop_composer");
}

export function onDictationComposer(handler: (result: DictationComposerResult) => void): Promise<UnlistenFn> {
  return listen<DictationComposerResult>("dictation:composer", (e) => handler(e.payload));
}
