import { describe, expect, it } from "vitest";
import { moveIndex } from "./listNav";

describe("moveIndex", () => {
  it("returns -1 for an empty list regardless of direction", () => {
    expect(moveIndex(-1, 0, 1)).toBe(-1);
    expect(moveIndex(0, 0, -1)).toBe(-1);
  });

  it("starts at the first row when nothing is selected and moving down", () => {
    expect(moveIndex(-1, 5, 1)).toBe(0);
  });

  it("starts at the last row when nothing is selected and moving up", () => {
    expect(moveIndex(-1, 5, -1)).toBe(4);
  });

  it("wraps from the last row to the first when moving down", () => {
    expect(moveIndex(4, 5, 1)).toBe(0);
  });

  it("wraps from the first row to the last when moving up", () => {
    expect(moveIndex(0, 5, -1)).toBe(4);
  });

  it("moves by a larger step (PageDown/PageUp) and still wraps", () => {
    expect(moveIndex(2, 10, 8)).toBe(0);
    expect(moveIndex(2, 10, -8)).toBe(4);
  });
});
