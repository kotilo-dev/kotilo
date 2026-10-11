import { describe, expect, it } from "vitest";
import { buildCellColumnMap, cellRangeFromStringRange, type CellLike } from "./cellColumnMap";

/** Test satırı yardımcı: her giriş bir hücre `{chars, width}` — `width: 0` devam hücresi. */
function makeLine(cells: Array<{ chars: string; width: number }>): (x: number) => CellLike | undefined {
  return (x: number) => {
    const c = cells[x];
    if (!c) return undefined;
    return { getChars: () => c.chars, getWidth: () => c.width };
  };
}

describe("buildCellColumnMap", () => {
  it("maps 1:1 for plain ASCII (no wide chars)", () => {
    const cells = [
      { chars: "a", width: 1 },
      { chars: "b", width: 1 },
      { chars: "c", width: 1 },
    ];
    const map = buildCellColumnMap(cells.length, makeLine(cells));
    expect(map).toEqual([0, 1, 2]);
  });

  it("skips width-0 continuation cells (a CJK wide char occupies 2 columns, 1 string index)", () => {
    // "中" at column 0 (width 2), column 1 is the continuation (width 0, no chars).
    const cells = [
      { chars: "中", width: 2 },
      { chars: "", width: 0 },
      { chars: "x", width: 1 },
    ];
    const map = buildCellColumnMap(cells.length, makeLine(cells));
    // translateToString(true) produces "中x" — 2 string indices, mapping to columns 0 and 2.
    expect(map).toEqual([0, 2]);
  });

  it("an empty cell still consumes one string index (the space translateToString emits)", () => {
    const cells = [
      { chars: "a", width: 1 },
      { chars: "", width: 1 },
      { chars: "b", width: 1 },
    ];
    const map = buildCellColumnMap(cells.length, makeLine(cells));
    expect(map).toEqual([0, 1, 2]);
  });

  it("a surrogate-pair emoji (2 UTF-16 units, width 2) consumes 2 string indices at the same column", () => {
    const emoji = "\u{1F600}"; // 2 UTF-16 code units
    const cells = [
      { chars: emoji, width: 2 },
      { chars: "", width: 0 },
      { chars: "y", width: 1 },
    ];
    const map = buildCellColumnMap(cells.length, makeLine(cells));
    expect(map).toEqual([0, 0, 2]);
  });
});

describe("cellRangeFromStringRange", () => {
  it("plain ASCII: string range equals cell range", () => {
    const cells = [
      { chars: "s", width: 1 },
      { chars: "r", width: 1 },
      { chars: "c", width: 1 },
    ];
    const getCell = makeLine(cells);
    const map = buildCellColumnMap(cells.length, getCell);
    expect(cellRangeFromStringRange(map, getCell, 0, 3)).toEqual({ startCol: 0, endCol: 3 });
  });

  it("a candidate ending exactly on a CJK wide char extends past both columns it occupies", () => {
    // columns: 0='中' (w2), 1=continuation, 2='.', 3='t', 4='s' — string "中.ts" (indices 0..3)
    const cells = [
      { chars: "中", width: 2 },
      { chars: "", width: 0 },
      { chars: ".", width: 1 },
      { chars: "t", width: 1 },
      { chars: "s", width: 1 },
    ];
    const getCell = makeLine(cells);
    const map = buildCellColumnMap(cells.length, getCell);
    // A candidate matching just "中" (string indices [0,1)) — the wide char occupies columns
    // 0 AND 1, so the exclusive end column must be 2, not 1.
    expect(cellRangeFromStringRange(map, getCell, 0, 1)).toEqual({ startCol: 0, endCol: 2 });
    // The full "中.ts" candidate (string indices [0,4)) ends on the plain 's' at column 4.
    expect(cellRangeFromStringRange(map, getCell, 0, 4)).toEqual({ startCol: 0, endCol: 5 });
  });

  it("a candidate starting after a CJK wide char has an offset start column", () => {
    // "中/foo.ts" — '中' at col 0 (w2), continuation at col1, '/' at col2, 'foo.ts' at col3..8.
    const cells = [
      { chars: "中", width: 2 },
      { chars: "", width: 0 },
      { chars: "/", width: 1 },
      { chars: "f", width: 1 },
      { chars: "o", width: 1 },
      { chars: "o", width: 1 },
      { chars: ".", width: 1 },
      { chars: "t", width: 1 },
      { chars: "s", width: 1 },
    ];
    const getCell = makeLine(cells);
    const map = buildCellColumnMap(cells.length, getCell);
    // string index for "/foo.ts" starts at string index 1 (after "中").
    expect(cellRangeFromStringRange(map, getCell, 1, 8)).toEqual({ startCol: 2, endCol: 9 });
  });

  it("an empty range collapses to a zero-width column range", () => {
    const cells = [{ chars: "a", width: 1 }];
    const getCell = makeLine(cells);
    const map = buildCellColumnMap(cells.length, getCell);
    expect(cellRangeFromStringRange(map, getCell, 0, 0)).toEqual({ startCol: 0, endCol: 0 });
  });
});
