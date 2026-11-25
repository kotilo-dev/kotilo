import { describe, expect, it } from "vitest";
import { nextUiScale, previousUiScale, snapUiScale, unscaledFontSize, UI_SCALES } from "./uiScale";

describe("uiScale", () => {
  it("divides font sizes by the zoom", () => {
    expect(unscaledFontSize(15, 125)).toBe(12);
    expect(unscaledFontSize(15, undefined)).toBe(15);
    expect(unscaledFontSize(13, 100)).toBe(13);
    expect(unscaledFontSize(15, 200)).toBe(7.5);
  });
  it("rounds to half pixels", () => {
    expect(unscaledFontSize(13, 125)).toBe(10.5);
    expect(unscaledFontSize(14, 110)).toBe(12.5);
  });
  it("snaps to the nearest step", () => {
    expect(snapUiScale(120)).toBe(125);
    expect(snapUiScale(undefined)).toBe(100);
    expect(snapUiScale(500)).toBe(200);
  });
  it("steps up and down, clamped", () => {
    expect(nextUiScale(100)).toBe(110);
    expect(nextUiScale(200)).toBe(200);
    expect(previousUiScale(100)).toBe(90);
    expect(previousUiScale(90)).toBe(90);
    expect(UI_SCALES).toContain(125);
  });
});
