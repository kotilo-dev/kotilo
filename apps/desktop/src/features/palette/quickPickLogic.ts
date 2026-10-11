/**
 * QuickPick saf mantığı (faz6-spec §5, §5.1 — VS Code modeli). Mod, ayrı bir state alanı
 * DEĞİL — girdi metninin kendisinden türetilir: `>` ile başlıyorsa komut modu. Bu sayede
 * "dosya modunda `>` yazmak komut moduna, komut modunda baştaki `>`'ı silmek dosya moduna
 * geçirir" davranışı otomatik olur (ekstra senkronizasyon gerekmez).
 */
import { fuzzyMatch } from "../../lib/fuzzy";
import { resolveCommandText, type Command } from "../../app/commands";

export type QuickPickMode = "file" | "command";

export function modeForInput(raw: string): QuickPickMode {
  return raw.startsWith(">") ? "command" : "file";
}

/** Mod öneki (`>`) çıkarılmış, filtrelemede kullanılacak asıl sorgu. */
export function queryForInput(raw: string): string {
  return modeForInput(raw) === "command" ? raw.slice(1) : raw;
}

// --- Komut modu: MRU + görünen etiket + filtre/sıralama (§5.1) -------------------------------

const MRU_LIMIT = 10;
/** Bellekte tutulur, kalıcı değil (oturum ömürlü) — kapanış/açılışta sıfırlanır. */
let mru: string[] = [];

export function recordCommandUsed(id: string): void {
  mru = [id, ...mru.filter((existing) => existing !== id)].slice(0, MRU_LIMIT);
}

export function getMru(): readonly string[] {
  return mru;
}

export function resetMruForTest(): void {
  mru = [];
}

/** Palette satırında gösterilen etiket: `category` varsa "Category: Title" (§5.1). */
export function commandLabel(command: Pick<Command, "title" | "category">): string {
  const title = resolveCommandText(command.title) ?? "";
  const category = resolveCommandText(command.category);
  return category ? `${category}: ${title}` : title;
}

export interface ScoredCommand {
  command: Command;
  /** `null` — boş sorguda (MRU/alfabetik sırada) vurgulanacak indeks yok. */
  indices: number[] | null;
}

/**
 * `enabled === false` döndüren komutlar listede hiç görünmez (§5.1). Boş sorgu → MRU (varsa)
 * üstte, ardından kategori+başlığa göre alfabetik; sorgulu ise fuzzy skoruna göre azalan
 * (eşitlikte etikete göre alfabetik, kararlı sıralama).
 */
export function filterCommands(commands: Command[], query: string): ScoredCommand[] {
  const enabled = commands.filter((c) => c.enabled === undefined || c.enabled());

  if (query.trim() === "") {
    const byId = new Map(enabled.map((c) => [c.id, c] as const));
    const mruCommands: Command[] = [];
    for (const id of mru) {
      const found = byId.get(id);
      if (found) mruCommands.push(found);
    }
    const mruIds = new Set(mruCommands.map((c) => c.id));
    const rest = enabled
      .filter((c) => !mruIds.has(c.id))
      .sort((a, b) => commandLabel(a).localeCompare(commandLabel(b)));
    return [...mruCommands, ...rest].map((command) => ({ command, indices: null }));
  }

  const scored: { command: Command; score: number; indices: number[] }[] = [];
  for (const command of enabled) {
    const match = fuzzyMatch(query, commandLabel(command));
    if (match) scored.push({ command, score: match.score, indices: match.indices });
  }
  scored.sort((a, b) => b.score - a.score || commandLabel(a.command).localeCompare(commandLabel(b.command)));
  return scored.map(({ command, indices }) => ({ command, indices }));
}

// --- Dosya modu: `rel` üzerindeki eşleşme indekslerinin dosya adına ofsetlenmesi (§5, review #7) ---

/**
 * `fsQuickOpen` (backend, nucleo-matcher) `indices`'i her zaman TAM `rel` yolu üzerinden döner.
 * QuickPick satırının ilk sütunu yalnızca dosya adını (`base`, `rel`'in son path segmenti)
 * gösterir — indeksler ofsetlenmeden doğrudan `base` metnine uygulanırsa (review #7) yanlış
 * karakterler vurgulanır, hatta `base`'in uzunluğunu aşan bir indeks tamamen görünmez bir
 * karaktere denk gelebilir. Bu saf fonksiyon yalnızca `base`'e düşen indeksleri, `base`
 * içindeki konumlarına ofsetleyerek döner (dizin kısmına düşenler burada atılır — o kısım
 * ayrıca tam `rel` üzerinden, ofsetsiz kendi indeksleriyle vurgulanır).
 *
 * `Array.from(...).length` (kod noktası sayısı) kullanılır, `.length` (UTF-16 birim sayısı)
 * DEĞİL — nucleo'nun Rust `char` indeksleriyle tutarlı kalmak için; aksi halde astral düzlem
 * karakterleri (ör. emoji) içeren yollarda ofset kayar.
 */
export function baseNameMatchIndices(rel: string, base: string, indices: number[] | null): number[] | null {
  if (!indices || indices.length === 0) return null;
  const offset = Array.from(rel).length - Array.from(base).length;
  const result = indices.filter((i) => i >= offset).map((i) => i - offset);
  return result.length > 0 ? result : null;
}
