/** A diff needs room to read: below this the viewer column is too narrow for code lines. */
export const VIEWER_MIN_WIDTH_PX = 480;

let handler: (() => void) | null = null;

/** `MainColumns` registers how to widen the viewer column (it owns the panel refs). Returns the unregister. */
export function registerViewerRoom(fn: () => void): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/**
 * After a diff opens: if the viewer column is narrower than ~480 px, widen it at the terminal column's
 * expense (the left column keeps its size).
 */
export function ensureViewerRoom(): void {
  // The viewer may still be collapsed at click time; measure after the layout settled.
  requestAnimationFrame(() => requestAnimationFrame(() => handler?.()));
}
