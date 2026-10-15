/**
 * Açık metin dosyaları için tek kaynak (faz3-spec §2 "documentStore", §5.5 bağlayıcı API).
 *
 * Key: `docKey(workspaceId, rel)`. Yaşam döngüsü (`load`/`release`) çağıranın (ViewerPanel)
 * sorumluluğundadır — bu store kendi başına hiçbir belgeyi otomatik yüklemez/atmaz, yalnızca
 * refcount tutar. Renderer'lar (Markdown/HTML kaynak dahil) metni buradan okur/yazar —
 * Frontend-B bu API'yi kullanır: `docKey`, `useDocument`, `useDocumentStore` aksiyonları
 * (`setText`, `save`, `reload`, `keepMine`), ve ayrıca `load`/`release`.
 */
import { create } from "zustand";
import { batchFsChanges } from "../lib/fsBatch";
import {
  type AppError,
  type Eol,
  type ReadOnlyReason,
  type TextEncoding,
  fsReadText,
  fsStat,
  fsWriteText,
  onFsChanged,
  onFsRescan,
  toAppError,
} from "../lib/ipc";
import { isSameOrDescendant, parentRel } from "../features/workspaces/paths";

export function docKey(workspaceId: string, rel: string): string {
  return `${workspaceId}\0${rel}`;
}

function splitKey(key: string): [string, string] {
  const idx = key.indexOf("\0");
  return [key.slice(0, idx), key.slice(idx + 1)];
}

/**
 * faz3-spec §2 belge şekli (flat — Frontend-B bu şekle bağımlı, değiştirilirse sözleşme
 * kırılır). `status !== "ready"` iken `text`/`savedText`/vb. anlamsızdır (placeholder).
 */
export interface Doc {
  status: "loading" | "ready" | "error";
  text: string;
  savedText: string;
  encoding: TextEncoding;
  eol: Eol;
  mixedEol: boolean;
  hash: string;
  readOnly: boolean;
  readOnlyReason: ReadOnlyReason | null;
  dirty: boolean;
  /** Dıştan değişiklik (veya kayıt sırasında `conflict`) tespit edildi — banner tetikler. */
  external: null | { hash: string };
  error?: AppError;
}

const LOADING_DOC: Doc = {
  status: "loading",
  text: "",
  savedText: "",
  encoding: "utf8",
  eol: "lf",
  mixedEol: false,
  hash: "",
  readOnly: false,
  readOnlyReason: null,
  dirty: false,
  external: null,
};

interface DocumentStore {
  docs: Record<string, Doc>;

  /** Sekme açılınca çağrılır (ViewerPanel); referans sayar, ilk çağrıda dosyayı okur. */
  load: (workspaceId: string, rel: string) => Promise<void>;
  /** Yalnızca Monaco `onChange`'den çağrılır (§5.16) — mount sırasında `getValue()` ile değil. */
  setText: (workspaceId: string, rel: string, text: string) => void;
  /** `fs_write_text` + `expectedHash`; snapshot semantiği §5.15. */
  save: (workspaceId: string, rel: string) => Promise<AppError | null>;
  reload: (workspaceId: string, rel: string) => Promise<void>;
  /** Dış değişikliği yok sayar, `hash`'i disk hash'ine günceller — bir sonraki kayıt üzerine yazar. */
  keepMine: (workspaceId: string, rel: string) => void;
  /** O belgeyi gösteren son sekme kapanınca çağrılır (ViewerPanel); son referansta bellekten atar. */
  release: (workspaceId: string, rel: string) => void;
}

const refCounts: Record<string, number> = {};
/** `fs:changed`/`fs:rescan`, belge hâlâ `"loading"` iken geldiyse: yükleme bitince yeniden kontrol edilir (§5.15). */
const pendingRecheck = new Set<string>();
/** finding #5: anahtar başına sürmekte olan `save()` zinciri — eşzamanlı çağrılar bunun üzerine kuyruklanır. */
const inFlightSaves: Record<string, Promise<AppError | null>> = {};
let listenersInstalled = false;

function readyDocFrom(file: { text: string; encoding: TextEncoding; eol: Eol; mixedEol: boolean; hash: string; readOnly: boolean; readOnlyReason: ReadOnlyReason | null }): Doc {
  return {
    status: "ready",
    text: file.text,
    savedText: file.text,
    encoding: file.encoding,
    eol: file.eol,
    mixedEol: file.mixedEol,
    hash: file.hash,
    readOnly: file.readOnly,
    readOnlyReason: file.readOnlyReason,
    dirty: false,
    external: null,
  };
}

export const useDocumentStore = create<DocumentStore>((set, get) => ({
  docs: {},

  load: async (workspaceId, rel) => {
    installListenersOnce(get, set);
    const key = docKey(workspaceId, rel);
    refCounts[key] = (refCounts[key] ?? 0) + 1;
    const existing = get().docs[key];
    if (existing) {
      // finding #10: kalıcı hatalar (binary_file/too_large — dosya değişmeden yeniden okumak
      // aynı sonucu verir) önbellekte kalır, ama geçici hatalar (io/not_found/vb. — ör. dosya
      // o an kilitliydi) yeni bir sekme açılışında tekrar denenmeli. `refCounts` yine de yukarıda
      // arttırıldı — bu doğru: bu çağrı da bir referans tutuyor.
      const isPersistentError =
        existing.status === "error" && (existing.error?.code === "binary_file" || existing.error?.code === "too_large");
      if (existing.status !== "error" || isPersistentError) return; // zaten yüklü/yükleniyor veya kalıcı hata
    }

    set((s) => ({ docs: { ...s.docs, [key]: LOADING_DOC } }));
    try {
      const file = await fsReadText(workspaceId, rel);
      // Yükleme sırasında belge kapatılmış olabilir (refcount 0); yine de sonucu yaz —
      // zararsız (bir sonraki `release` zaten temizler), ama tutarlı önbellek sağlar.
      set((s) => ({ docs: { ...s.docs, [key]: readyDocFrom(file) } }));
      if (pendingRecheck.has(key)) {
        pendingRecheck.delete(key);
        void recheckExternal(get, set, workspaceId, rel);
      }
    } catch (e) {
      set((s) => ({ docs: { ...s.docs, [key]: { ...LOADING_DOC, status: "error", error: toAppError(e) } } }));
    }
  },

  setText: (workspaceId, rel, text) => {
    const key = docKey(workspaceId, rel);
    set((s) => {
      const doc = s.docs[key];
      if (!doc || doc.status !== "ready") return {};
      if (doc.text === text) return {};
      return { docs: { ...s.docs, [key]: { ...doc, text, dirty: text !== doc.savedText } } };
    });
  },

  // finding #5: aynı anahtar için eşzamanlı `save()` çağrıları zincirlenir — asla iki yazım aynı
  // anda gitmez (bayat `expectedHash` riski yok). Zincirdeki her adım kendi sırası geldiğinde
  // belgeye tekrar bakar; `performSave` o an dirty değilse yazmadan `null` döner (coalesce).
  save: (workspaceId, rel) => {
    const key = docKey(workspaceId, rel);
    const prior = inFlightSaves[key];
    // Bekleyen bir kayıt yoksa `performSave` **doğrudan** çağrılır (zincirlenmez) — §5.15'in
    // "kayıt başlarken metnin anlık görüntüsü alınır" kuralı senkron olmalı: bir `.then()`
    // araya bir microtask koyar ve çağıranın hemen ardından yapabileceği bir `setText` snapshot'a
    // sızabilir. Zincirleme yalnızca gerçekten bekleyen bir öncekinin ardına eklenirken devreye
    // girer (finding #5) — o zaman zaten geciktirmek istediğimiz doğru davranıştır.
    const chained: Promise<AppError | null> = prior
      ? prior.then(() => performSave(get, set, workspaceId, rel))
      : performSave(get, set, workspaceId, rel);
    inFlightSaves[key] = chained;
    void chained.finally(() => {
      if (inFlightSaves[key] === chained) delete inFlightSaves[key];
    });
    return chained;
  },

  reload: async (workspaceId, rel) => {
    const key = docKey(workspaceId, rel);
    try {
      const file = await fsReadText(workspaceId, rel);
      // finding #3: bu buton her zaman koşulsuz uygulanır (bkz. üst yorum) — ama sekme/belge bu
      // arada `release` edilmişse (anahtar silinmiş) diriltilmez.
      set((s) => {
        if (!(key in s.docs)) return {};
        return { docs: { ...s.docs, [key]: readyDocFrom(file) } };
      });
    } catch (e) {
      set((s) => {
        if (!(key in s.docs)) return {};
        return { docs: { ...s.docs, [key]: { ...LOADING_DOC, status: "error", error: toAppError(e) } } };
      });
    }
  },

  keepMine: (workspaceId, rel) => {
    const key = docKey(workspaceId, rel);
    set((s) => {
      const doc = s.docs[key];
      if (!doc || doc.status !== "ready" || !doc.external) return {};
      return { docs: { ...s.docs, [key]: { ...doc, hash: doc.external.hash, external: null } } };
    });
  },

  release: (workspaceId, rel) => {
    const key = docKey(workspaceId, rel);
    const existing = refCounts[key];
    // finding #4: hiç referansı olmayan bir anahtarda `release` no-op'tur — asla negatife
    // gitmez ve (varsayılan `1` üzerinden çıkarma yaparak) başka bir sekmenin hâlâ tuttuğu
    // belgeyi yanlışlıkla silmez.
    if (existing === undefined) return;
    const next = existing - 1;
    if (next <= 0) {
      delete refCounts[key];
      pendingRecheck.delete(key);
      set((s) => {
        if (!(key in s.docs)) return {};
        const docs = { ...s.docs };
        delete docs[key];
        return { docs };
      });
    } else {
      refCounts[key] = next;
    }
  },
}));

export function useDocument(workspaceId: string, rel: string): Doc | undefined {
  return useDocumentStore((s) => s.docs[docKey(workspaceId, rel)]);
}

type Getter = () => DocumentStore;
type Setter = (partial: Partial<DocumentStore> | ((s: DocumentStore) => Partial<DocumentStore>)) => void;

/** `save()`'in gövdesi — `inFlightSaves` zincirinin her adımı bunu çağırır (finding #5). */
async function performSave(get: Getter, set: Setter, workspaceId: string, rel: string): Promise<AppError | null> {
  const key = docKey(workspaceId, rel);
  const doc = get().docs[key];
  if (!doc || doc.status !== "ready") return null;
  if (doc.readOnly) return null; // finding #2: salt okunur belge asla yazılmaz
  if (!doc.dirty) return null; // finding #5: zincirdeki bu adıma geldiğimizde zaten temizse yazmaya gerek yok

  // §5.15: kayıt başlarken metnin anlık görüntüsü alınır; kayıt sırasında yazılanlar dirty kalır.
  const snapshot = doc.text;
  try {
    const result = await fsWriteText(workspaceId, rel, snapshot, doc.encoding, doc.eol, doc.hash || null);
    set((s) => {
      const current = s.docs[key];
      if (!current || current.status !== "ready") return {};
      return {
        docs: {
          ...s.docs,
          [key]: {
            ...current,
            savedText: snapshot,
            hash: result.hash,
            dirty: current.text !== snapshot,
            external: null,
          },
        },
      };
    });
    return null;
  } catch (e) {
    const err = toAppError(e);
    if (err.code === "conflict") {
      try {
        const stat = await fsStat(workspaceId, rel);
        set((s) => {
          const current = s.docs[key];
          if (!current || current.status !== "ready") return {};
          return { docs: { ...s.docs, [key]: { ...current, external: { hash: stat.hash } } } };
        });
      } catch {
        // Dosya da artık yoksa (silinmiş): viewerStore'un "Deleted on disk" akışı devreye girer.
      }
    }
    return err;
  }
}

/**
 * Diskteki hash'i mevcut belgeninkiyle karşılaştırır: aynıysa no-op, farklıysa temiz → sessiz
 * yeniden okuma, dirty → banner. finding #3: sessiz yeniden okuma **iki aşamalı** doğrulanır —
 * `fs_stat` sonrası (okumaya başlamadan önce) ve `fs_read_text` sonrası (uygulamadan önce) —
 * çünkü ikisi de await'li ve arada belge kapanabilir (`release`), dirty olabilir, ya da başka
 * bir save/reload zaten aynı hash değişikliğini ele almış olabilir. Hiçbiri doğruysa taze
 * metin sessizce uygulanır; dirty olduysa metne dokunmadan `external` (banner) set edilir;
 * anahtar mevcut değilse (release edilmiş) hiçbir şey diriltilmez.
 */
async function recheckExternal(get: Getter, set: Setter, workspaceId: string, rel: string): Promise<void> {
  const key = docKey(workspaceId, rel);
  const doc = get().docs[key];
  if (!doc || doc.status !== "ready") return;
  const priorHash = doc.hash;

  let stat: { hash: string };
  try {
    stat = await fsStat(workspaceId, rel);
  } catch {
    return; // Dosya artık yok — viewerStore'un tab-missing akışı bunu ele alır.
  }
  if (stat.hash === priorHash) return; // kendi yazdığımız değişiklik dahil: hiçbir şey yapma

  const afterStat = get().docs[key];
  if (!afterStat || afterStat.status !== "ready") return; // release edilmiş / duruma geçmiş — diriltme
  if (afterStat.hash !== priorHash) return; // arada başka bir şey (save/reload) bu hash değişikliğini zaten ele aldı

  if (afterStat.dirty) {
    set((s) => {
      const d = s.docs[key];
      if (!d || d.status !== "ready") return {};
      return { docs: { ...s.docs, [key]: { ...d, external: { hash: stat.hash } } } };
    });
    return;
  }

  let file: Awaited<ReturnType<typeof fsReadText>>;
  try {
    file = await fsReadText(workspaceId, rel);
  } catch {
    return; // Okuma sırasında dosya kayboldu — tab-missing akışı ele alır; belgeye dokunma.
  }

  set((s) => {
    const d = s.docs[key];
    if (!d || d.status !== "ready") return {}; // release edilmiş / duruma geçmiş — diriltme
    if (d.text !== d.savedText) return { docs: { ...s.docs, [key]: { ...d, external: { hash: file.hash } } } }; // okurken dirty oldu — banner
    if (d.hash !== priorHash) return {}; // arada başka bir şey zaten güncellemiş — bizim okumamız bayat
    return { docs: { ...s.docs, [key]: readyDocFrom(file) } };
  });
}

function installListenersOnce(get: Getter, set: Setter): void {
  if (listenersInstalled) return;
  listenersInstalled = true;

  void onFsChanged(batchFsChanges(({ workspaceId, dirs }) => {
    for (const key of Object.keys(get().docs)) {
      const [ws, rel] = splitKey(key);
      if (ws !== workspaceId) continue;
      // finding #11: `dirs` yalnızca üst düzey değişen klasörleri listeler — eşitlik yerine
      // soyundan gelme kontrolü, yeniden adlandırılan/silinen bir klasörün derinlerindeki açık
      // belgelerin de denetlenmesini sağlar.
      if (!dirs.some((d) => isSameOrDescendant(parentRel(rel), d))) continue;
      const doc = get().docs[key];
      if (doc?.status === "loading") {
        pendingRecheck.add(key);
        continue;
      }
      void recheckExternal(get, set, ws, rel);
    }
  }));

  void onFsRescan(({ workspaceId }) => {
    for (const key of Object.keys(get().docs)) {
      const [ws, rel] = splitKey(key);
      if (ws !== workspaceId) continue;
      const doc = get().docs[key];
      if (doc?.status === "loading") {
        pendingRecheck.add(key);
        continue;
      }
      void recheckExternal(get, set, ws, rel);
    }
  });
}

/**
 * `viewerStore.retarget` tarafından çağrılır (faz3-spec §5.8: "belge anahtarları da taşınır").
 * Frontend-B'nin genel API'sinin parçası değildir.
 */
export function rekeyDocsForRetarget(workspaceId: string, oldRel: string, newRel: string): void {
  const refUpdates: Array<[string, string]> = [];
  useDocumentStore.setState((s) => {
    let changed = false;
    const docs: Record<string, Doc> = {};
    for (const [key, doc] of Object.entries(s.docs)) {
      const [ws, rel] = splitKey(key);
      if (ws === workspaceId && isSameOrDescendant(rel, oldRel)) {
        const newRelFull = newRel + rel.slice(oldRel.length);
        const newKey = docKey(ws, newRelFull);
        docs[newKey] = doc;
        refUpdates.push([key, newKey]);
        changed = true;
      } else {
        docs[key] = doc;
      }
    }
    if (!changed) return {};
    return { docs };
  });
  for (const [oldKey, newKey] of refUpdates) {
    if (oldKey in refCounts) {
      refCounts[newKey] = (refCounts[newKey] ?? 0) + refCounts[oldKey];
      delete refCounts[oldKey];
    }
    if (pendingRecheck.has(oldKey)) {
      pendingRecheck.delete(oldKey);
      pendingRecheck.add(newKey);
    }
  }
}
