/**
 * Ayarlar (faz6-spec §1.3, §10.5 — BAĞLAYICI revizyon). Tek doğruluk kaynağı backend'dir
 * (`settings_get`/`settings_set`) ama `update(patch)` **optimistik**: yerel state hemen
 * birleştirilir, `settings_set` çağrıları sıralıdır (aynı anda tek istek; kuyrukta bekleyen
 * varsa yalnızca en son tam state gönderilir — ara adımlar atlanır). Hata → son sunucu-onaylı
 * değere geri dönülür + `lastError` set edilir.
 *
 * Review #12: bu tek pencereli bir uygulama ve ayarları değiştiren TEK taraf bu frontend'dir —
 * `settings:changed` backend event'i bu yüzden her zaman kendi `settings_set` yazımımızın
 * yankısıdır, asla başka bir yazardan gelmez. Önceki sürüm bu event'i dinleyip (bekleyen bir
 * yazım yoksa) uyguluyordu; ama sıralı kuyruk boşaldığı an ile event'in gelişi arasında bir
 * yarış vardı — BAYAT bir yankı, ondan SONRA başlayan taze bir `update()`'in henüz `settings_set`
 * yanıtı dönmeden state'ini ezebiliyordu. Event tamamen kaldırıldı; tek doğruluk kaynağı artık
 * `settings_set`'in kendi (sıralı, kuyruklu) yanıtı — bkz. `flushQueue`. (`onSettingsChanged`
 * ipc.ts'ten de kaldırıldı, başka hiçbir yerde kullanılmıyordu.)
 *
 * `main.tsx` render'dan önce `hydrateSettingsStore` ile bu store'u doldurur (tema flaşı
 * olmasın diye) — `init()` bileşen tarafında tekrar çağrılırsa (StrictMode dahil) `ready`
 * zaten `true` olduğundan ikinci bir `settings_get` atmaz.
 */
import { create } from "zustand";
import { settingsGet, settingsSet, toAppError, type AppError, type Settings } from "../lib/ipc";

export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Rust tarafındaki varsayılanlarla birebir (faz6-spec §1.1) — `settings_get` başarısız olursa kullanılır. */
export const DEFAULT_SETTINGS: Settings = {
  v: 1,
  theme: "dark",
  editor: { fontFamily: "Cascadia Code, Consolas, monospace", fontSize: 13 },
  terminal: {
    fontFamily: '"Geist Mono", "Cascadia Code", Consolas, monospace',
    // faz6-spec §1.1 "mevcut değer": önceden `defaultCreateTerminal()` fontSize'ı hiç
    // belirtmiyordu — xterm'in kendi varsayılanı (15) kullanılıyordu; burada aynen korunur.
    fontSize: 15,
    defaultShell: null,
    copyOnSelect: false,
    warnMultilinePaste: true,
  },
  agents: { commands: ["claude", "codex"], notifications: true },
  files: { hiddenPatterns: [".git", "node_modules", "dist", "target", ".DS_Store"], respectGitignore: false },
  clipboard: { copyPathAfterImageSave: true },
  diagnostics: { verboseLogging: false },
  composer: { savedPrompts: [], attachmentsHintShown: false },
  updates: { checkOnStart: true },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Diziler bütün olarak değiştirilir (öğe öğe birleştirilmez) — yalnızca düz nesneler derinden birleşir. */
export function deepMergeSettings<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    result[key] = deepMergeSettings((base as Record<string, unknown>)[key], value as DeepPartial<unknown>);
  }
  return result as T;
}

interface SettingsStore {
  ready: boolean;
  settings: Settings;
  /** Son başarısız `update`'in hatası — bir sonraki başarılı `settings_set` yazımında temizlenir. */
  lastError: AppError | null;
  /**
   * Backend'in onayladığı (diske yazılmış) son değer. `settings` optimistiktir; backend'in
   * uyguladığı ayarlara bağlı yeniden okumalar (ör. ağaçta gizleme/`.gitignore`) bunu izlemeli —
   * yoksa `fs_read_dir` henüz eski ayarlarla çalışırken tetiklenip bir adım geride kalır.
   */
  confirmed: Settings;

  init: () => Promise<void>;
  update: (patch: DeepPartial<Settings>) => void;
}

let inFlight = false;
/** Kuyrukta bekleyen en son tam state — ara `update` çağrıları burada üst üste yazılır (yalnızca sonuncusu gönderilir). */
let queued: Settings | null = null;

function flushQueue(): void {
  if (inFlight || !queued) return;
  const next = queued;
  queued = null;
  inFlight = true;
  void settingsSet(next)
    .then((result) => {
      inFlight = false;
      // Kuyrukta bu sırada yeni bir istek birikmediyse sunucunun normalize ettiği hali uygula.
      if (!queued) useSettingsStore.setState({ settings: result, confirmed: result, lastError: null });
      else useSettingsStore.setState({ confirmed: result });
      flushQueue();
    })
    .catch((e) => {
      inFlight = false;
      queued = null;
      const { confirmed } = useSettingsStore.getState();
      useSettingsStore.setState({ settings: confirmed, lastError: toAppError(e) });
    });
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ready: false,
  settings: DEFAULT_SETTINGS,
  lastError: null,
  confirmed: DEFAULT_SETTINGS,

  init: async () => {
    if (get().ready) return;
    try {
      const settings = await settingsGet();
      set({ settings, confirmed: settings, ready: true });
    } catch {
      set({ settings: DEFAULT_SETTINGS, confirmed: DEFAULT_SETTINGS, ready: true });
    }
  },

  update: (patch) => {
    const merged = deepMergeSettings(get().settings, patch);
    set({ settings: merged });
    queued = merged;
    flushQueue();
  },
}));

/** `main.tsx` render'dan önce çağırır (faz6-spec §1.3): tema flaşı olmasın diye. */
export function hydrateSettingsStore(settings: Settings): void {
  useSettingsStore.setState({ settings, confirmed: settings, ready: true });
}

/** Testler arası temizlik (modül düzeyi kuyruk durumu + store state). */
export function resetSettingsStoreForTest(): void {
  inFlight = false;
  queued = null;
  useSettingsStore.setState({ ready: false, settings: DEFAULT_SETTINGS, confirmed: DEFAULT_SETTINGS, lastError: null });
}
