/**
 * Terminal çıktısındaki dosya yolu adaylarının saf çıkarımı (faz4-spec §2.6, §4.6).
 * DOM/xterm'e dokunmaz — bir satırın düz metnini alır, aday listesi döner. URL'ler
 * (`@xterm/addon-web-links` onları zaten yakalıyor) hariç tutulur.
 *
 * Desteklenen biçimler: `src/foo.ts`, `.\src\foo.ts:42`, `src/foo.ts:42:7`,
 * `src/foo.ts(42,7)` (MSBuild/tsc), `C:\dev\proj\src\foo.ts:42`, `/c/dev/proj/src/foo.ts`
 * (Git Bash), tırnak/parantez içindeki yollar (regex karakter sınıfı zaten tırnak/parantezi
 * dışlıyor — aday doğal olarak onları içermez).
 */

export interface LinkCandidate {
  /** Yol + varsa satır/sütun soneki dahil tam metin (link aralığının kapsadığı kısım). */
  text: string;
  /** Satırdaki başlangıç index'i (0-tabanlı, dahil). */
  start: number;
  /** Satırdaki bitiş index'i (0-tabanlı, hariç). */
  end: number;
  /** Yalnızca yol kısmı (sonek hariç) — `fs_resolve_link`'e gönderilecek aday. */
  pathPart: string;
  line: number | null;
  column: number | null;
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>]*/gi;

// Öneki: sürücü harfi ("C:\"), Git Bash mutlak yolu ("/c/"), ya da "./"/".\" — hepsi opsiyonel.
// Ana gövde: en az bir "segment + ayraç" grubu, sonunda bir segment daha (tek başına "foo.ts"
// bir aday değildir — gürültüyü azaltmak için en az bir ayraç şart).
const PATH_RE = /(?:[A-Za-z]:[\\/]|\/[A-Za-z]\/|\.[\\/])?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+/g;

const COLON_SUFFIX_RE = /^:(\d+)(?::(\d+))?/;
const PAREN_SUFFIX_RE = /^\((\d+),(\d+)\)/;

function findExcludedRanges(lineText: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of lineText.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    ranges.push([start, start + m[0].length]);
  }
  return ranges;
}

function overlapsAny(ranges: Array<[number, number]>, start: number, end: number): boolean {
  return ranges.some(([es, ee]) => start < ee && end > es);
}

/** Bir satır metnindeki tüm dosya yolu adaylarını (URL'ler hariç) çıkarır. */
export function extractLinkCandidates(lineText: string): LinkCandidate[] {
  const excluded = findExcludedRanges(lineText);
  const results: LinkCandidate[] = [];

  for (const m of lineText.matchAll(PATH_RE)) {
    const start = m.index ?? 0;
    const pathPart = m[0];
    const pathEnd = start + pathPart.length;
    if (overlapsAny(excluded, start, pathEnd)) continue;

    let end = pathEnd;
    let line: number | null = null;
    let column: number | null = null;

    const rest = lineText.slice(pathEnd);
    const colonMatch = COLON_SUFFIX_RE.exec(rest);
    const parenMatch = PAREN_SUFFIX_RE.exec(rest);
    if (colonMatch) {
      line = Number(colonMatch[1]);
      column = colonMatch[2] !== undefined ? Number(colonMatch[2]) : null;
      end += colonMatch[0].length;
    } else if (parenMatch) {
      line = Number(parenMatch[1]);
      column = Number(parenMatch[2]);
      end += parenMatch[0].length;
    }

    results.push({ text: lineText.slice(start, end), start, end, pathPart, line, column });
  }

  return results;
}
