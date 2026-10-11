/**
 * Komut paleti (faz6-spec §5.1) için saf fuzzy alt-dizi (subsequence) eşleştirici. Backend'in
 * dosya arama motoru (nucleo-matcher) ile karıştırılmamalı — bu yalnızca bellek içi, küçük
 * komut listesi (birkaç düzine öğe) üzerinde çalışır.
 *
 * Puanlama: her eşleşen karakter 1 puan; bir öncekiyle ardışıksa (+3, "art arda eşleşme"
 * bonusu); bir "kelime başı"ndaysa (dizinin başı ya da öncesinde boşluk/`-`/`_`/`/`/`\`/`.`
 * varsa) +2; büyük/küçük harf birebir aynıysa +1 (ör. sorgu "VP" hedef "View: toggle" içindeki
 * "V" ve "P"leri değil "V"yi tam eşleştirir). Sol-dan-sağa açgözlü (greedy) tarama — en yüksek
 * olası skoru garanti etmez ama basit, deterministik ve komut paleti ölçeğinde yeterlidir.
 */
export interface FuzzyMatch {
  score: number;
  indices: number[];
}

const WORD_BOUNDARY_BEFORE = /[\s\-_/\\.]/;

/** `query` `target`'ın bir alt-dizisi değilse `null`. Boş `query` → skor 0, indeks yok. */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query === "") return { score: 0, indices: [] };

  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let qi = 0;
  let lastMatchIndex = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;

    let charScore = 1;
    if (lastMatchIndex === ti - 1) charScore += 3;
    const prevChar = ti > 0 ? target[ti - 1] : undefined;
    const isWordStart = ti === 0 || (prevChar !== undefined && WORD_BOUNDARY_BEFORE.test(prevChar));
    if (isWordStart) charScore += 2;
    if (target[ti] === query[qi]) charScore += 1;

    score += charScore;
    indices.push(ti);
    lastMatchIndex = ti;
    qi++;
  }

  if (qi < q.length) return null; // `query` `target`'ın alt-dizisi değil
  return { score, indices };
}
