/**
 * `translateToString(true)` dize index'lerinden xterm hücre sütunlarına saf çevrim
 * (faz4-spec §2.6, §4.6, LOW #8b). Genişlik-2 hücreler (CJK, emoji, claude'un TUI'si) tek bir
 * dize karakteri (bazen bir surrogate çifti) üretirken İKİ sütun kaplar; genişlik-0 "devam"
 * hücreleri dizeye hiç katkı yapmaz. `linkCandidates.extractLinkCandidates` çıktısındaki
 * `start`/`end` (dize index'i) bu yüzden doğrudan hücre sütunu olarak kullanılamaz — bu modül
 * dize index'i → hücre sütunu eşlemesini kurar. DOM/xterm'e dokunmaz (saf); `TerminalView` bunu
 * gerçek `IBufferLine.getCell` ile besler, testler sahte hücre nesneleriyle.
 */

export interface CellLike {
  getChars(): string;
  getWidth(): number;
}

/**
 * `line.translateToString(true)`'ın ürettiği dizedeki her index için, o karakteri üreten
 * hücrenin sütununu döner (`map[stringIndex] = cellColumn`). Genişlik-0 devam hücreleri atlanır;
 * boş bir hücre (`getChars() === ""`) `translateToString`'in ürettiği tek boşluk karakterine
 * karşılık gelecek şekilde bir index tüketir.
 */
export function buildCellColumnMap(cols: number, getCell: (x: number) => CellLike | undefined): number[] {
  const map: number[] = [];
  for (let x = 0; x < cols; x++) {
    const cell = getCell(x);
    const width = cell?.getWidth() ?? 1;
    if (width === 0) continue; // genişlik-2 bir hücrenin devamı — dizeye katkısı yok
    const chars = cell?.getChars() ?? "";
    const len = chars.length || 1; // boş hücre → translateToString'de tek boşluk karakteri
    for (let i = 0; i < len; i++) map.push(x);
  }
  return map;
}

/**
 * `[start, end)` dize aralığını (`extractLinkCandidates`'ın `start`/`end`'i) `[startCol, endCol)`
 * hücre sütun aralığına çevirir. `endCol` son eşlenen hücrenin genişliği kadar ileri alınır —
 * genişlik-2 bir hücrede biten bir aday, o hücrenin kapladığı iki sütunun da ötesine geçmeli.
 */
export function cellRangeFromStringRange(
  colForIndex: number[],
  getCell: (x: number) => CellLike | undefined,
  start: number,
  end: number,
): { startCol: number; endCol: number } {
  const cols = colForIndex.length;
  if (end <= start || cols === 0) {
    const col = colForIndex[start] ?? start;
    return { startCol: col, endCol: col };
  }
  const startCol = colForIndex[start] ?? Math.min(start, colForIndex[cols - 1] ?? start);
  const lastCol = colForIndex[end - 1] ?? startCol;
  const lastWidth = getCell(lastCol)?.getWidth() || 1;
  return { startCol, endCol: lastCol + lastWidth };
}
