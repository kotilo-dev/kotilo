/**
 * The mascot window's page (`index.html?view=mascot`, M6, D-052). Rust sizes the transparent
 * window to 2H × 2H (H = 16 × scale) and moves it; this page draws the snail bottom-centred,
 * its speech bubble / Zz above it, and reports clicks, the context menu and horizontal drags.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, PointerEvent } from "react";
import { APP_NAME } from "../../app/constants";
import { MascotSnail } from "./MascotSnail";
import { mascotClicked, mascotContextMenu, mascotDrag, mascotDragEnd, mascotReady, onMascotState } from "./mascotIpc";
import { bubbleFor, INITIAL_MASCOT_STATE, mergeMascotState, snailHeight, type MascotStatePayload } from "./mascotState";
import { beginGesture, endGesture, moveGesture, takeDx, type Gesture } from "./pointerGesture";
import "./mascot.css";

const ignore = () => {};

export function MascotView({ initial = INITIAL_MASCOT_STATE }: { initial?: MascotStatePayload }) {
  const [m, setM] = useState<MascotStatePayload>(initial);
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;
    const unlisten = onMascotState((payload) => setM((prev) => mergeMascotState(prev, payload)));
    void unlisten.then(() => {
      if (!disposed) void mascotReady().catch(ignore);
    });
    return () => {
      disposed = true;
      void unlisten.then((fn) => fn());
    };
  }, []);

  const flush = useCallback(() => {
    frame.current = null;
    const g = gesture.current;
    if (!g) return;
    const [dx, next] = takeDx(g);
    gesture.current = next;
    if (dx !== 0) void mascotDrag(dx).catch(ignore);
  }, []);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    gesture.current = beginGesture(e.pointerId, e.screenX, e.screenY);
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = moveGesture(g, e.screenX, e.screenY);
    if (gesture.current.dragging && frame.current === null) frame.current = requestAnimationFrame(flush);
  };

  const finish = (e: PointerEvent<HTMLElement>, cancelled: boolean) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    const [dx, done] = takeDx(cancelled ? g : moveGesture(g, e.screenX, e.screenY));
    gesture.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (endGesture(done) === "drag-end") {
      if (dx !== 0) void mascotDrag(dx).catch(ignore);
      void mascotDragEnd().catch(ignore);
    } else if (!cancelled) {
      void mascotClicked().catch(ignore);
    }
  };

  const onContextMenu = (e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    void mascotContextMenu().catch(ignore);
  };

  const bubble = bubbleFor(m.state);
  const walking = m.walking && (m.state === "work" || m.state === "sweat");
  const handlers = {
    onPointerDown,
    onPointerMove,
    onPointerUp: (e: PointerEvent<HTMLElement>) => finish(e, false),
    onPointerCancel: (e: PointerEvent<HTMLElement>) => finish(e, true),
    onContextMenu,
  };

  return (
    <div
      className="mascot"
      data-state={m.state}
      data-direction={m.direction}
      data-walking={walking ? "true" : "false"}
      data-celebrate={m.celebrate ? "true" : "false"}
      style={{ "--mh": `${snailHeight(m.scale)}px` } as CSSProperties}
    >
      {bubble && (
        <div className="ms-bubble" data-testid="mascot-bubble" aria-hidden="true" {...handlers}>
          <span className="ms-bubble-text">{bubble}</span>
        </div>
      )}
      {m.state === "sleep" && (
        <div className="ms-zz" aria-hidden="true">
          <span>z</span>
          <span>Z</span>
        </div>
      )}
      <div
        key={m.state}
        className="ms-body"
        role="img"
        aria-label={m.label || APP_NAME}
        data-testid="mascot-snail"
        {...handlers}
      >
        <MascotSnail direction={m.direction} />
      </div>
    </div>
  );
}
