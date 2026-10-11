import { describe, expect, it } from "vitest";
import { beginGesture, endGesture, moveGesture, takeDx } from "./pointerGesture";

describe("pointer gesture", () => {
  it("a press without movement past 4 px is a click", () => {
    let g = beginGesture(1, 100, 100);
    g = moveGesture(g, 103, 102);
    expect(g.dragging).toBe(false);
    expect(takeDx(g)[0]).toBe(0);
    expect(endGesture(g)).toBe("click");
  });

  it("past the threshold it drags and reports the delta since the start, then since the last take", () => {
    let g = beginGesture(1, 100, 100);
    g = moveGesture(g, 106, 100);
    expect(g.dragging).toBe(true);
    let dx: number;
    [dx, g] = takeDx(g);
    expect(dx).toBe(6);
    g = moveGesture(g, 110, 140);
    g = moveGesture(g, 104, 140);
    [dx, g] = takeDx(g);
    expect(dx).toBe(-2);
    expect(takeDx(g)[0]).toBe(0);
    expect(endGesture(g)).toBe("drag-end");
  });

  it("vertical movement starts a drag but adds no horizontal delta", () => {
    const g = moveGesture(beginGesture(1, 0, 0), 0, 10);
    expect(g.dragging).toBe(true);
    expect(takeDx(g)[0]).toBe(0);
  });
});
