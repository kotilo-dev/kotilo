/**
 * faz7-spec §12.4: "F1 is a no-op while any other modal is open (QuickPick, Confirm,
 * PasteWarning, UnsavedChanges, Help itself)." Help's own open state is checked
 * directly (`helpStore`) by the F1 command — this module only tracks the OTHER modals, each of
 * which pushes on mount (or on its own `open`/`isOpen` becoming true) and pops on unmount/close.
 *
 * Deliberately a plain module-level counter, not a zustand store: callers only need a
 * point-in-time synchronous check when the F1 shortcut fires (a real keypress, always AFTER any
 * mount effect from opening a modal has already run) — nothing needs to re-render when this
 * changes.
 */
let openCount = 0;

/** Call on mount (or when the modal's own `open` becomes true). Returns the matching pop. */
export function pushModalOpen(): () => void {
  openCount += 1;
  let popped = false;
  return () => {
    if (popped) return;
    popped = true;
    openCount = Math.max(0, openCount - 1);
  };
}

export function isOtherModalOpen(): boolean {
  return openCount > 0;
}

/** Test-only: resets the counter between tests that don't unmount every pushed modal. */
export function resetModalStackForTest(): void {
  openCount = 0;
}
