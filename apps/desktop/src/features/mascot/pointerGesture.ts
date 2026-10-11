/**
 * Click vs. drag on the mascot (M6): a primary-button press that moves more than
 * `DRAG_THRESHOLD` CSS px becomes a drag; otherwise the release is a click. Coordinates are
 * screen coordinates (`PointerEvent.screenX/Y`), because the window itself moves under the
 * pointer while dragging and client coordinates would feed that movement back.
 */

export const DRAG_THRESHOLD = 4;

export interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  /** Last screen X already accounted for in a drag delta. */
  lastX: number;
  dragging: boolean;
  /** Horizontal delta not yet sent with `mascot_drag`. */
  pendingDx: number;
}

export function beginGesture(pointerId: number, x: number, y: number): Gesture {
  return { pointerId, startX: x, startY: y, lastX: x, dragging: false, pendingDx: 0 };
}

/** Pointer moved: starts the drag past the threshold and accumulates the horizontal delta. */
export function moveGesture(g: Gesture, x: number, y: number): Gesture {
  if (!g.dragging) {
    if (Math.hypot(x - g.startX, y - g.startY) <= DRAG_THRESHOLD) return g;
    return { ...g, dragging: true, pendingDx: g.pendingDx + (x - g.lastX), lastX: x };
  }
  return { ...g, pendingDx: g.pendingDx + (x - g.lastX), lastX: x };
}

/** Takes the accumulated delta (sent once per animation frame). */
export function takeDx(g: Gesture): [number, Gesture] {
  return [g.pendingDx, { ...g, pendingDx: 0 }];
}

/** How a released gesture ends. */
export function endGesture(g: Gesture): "click" | "drag-end" {
  return g.dragging ? "drag-end" : "click";
}
