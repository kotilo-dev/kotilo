/**
 * QuickPick liste gezinme (faz6-spec §5: ↑/↓, PageUp/PageDown) — saf, döngüsel (wrap-around)
 * indeks hesabı. `length<=0` için her zaman `-1` (seçili satır yok).
 */
export function moveIndex(current: number, length: number, delta: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : length - 1;
  const next = (current + delta) % length;
  return next < 0 ? next + length : next;
}

export const PAGE_STEP = 8;
