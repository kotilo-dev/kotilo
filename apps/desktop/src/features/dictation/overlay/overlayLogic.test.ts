import { describe, expect, it } from "vitest";
import { barHeight, BAR_COUNT, formatElapsed, overlayLines, pushLevel } from "./overlayLogic";
import { en } from "../../../app/i18n/en";
import type { DictationOverlayState } from "../../../lib/ipc";

const t = en.dictation.overlay;
const base: DictationOverlayState = { phase: "recording", mode: "undecided", elapsedMs: 7_400, level: 0, result: null, sound: null };

describe("overlay logic", () => {
  it("bar height is 3 + sqrt(level) * 40, clamped to 3..24", () => {
    expect(barHeight(0)).toBe(3);
    expect(barHeight(-1)).toBe(3);
    expect(barHeight(0.01)).toBeCloseTo(7);
    expect(barHeight(0.25)).toBe(23);
    expect(barHeight(1)).toBe(24);
  });

  it("keeps the latest 18 levels, oldest first", () => {
    let levels: number[] = [];
    for (let i = 0; i < 25; i++) levels = pushLevel(levels, i);
    expect(levels).toHaveLength(BAR_COUNT);
    expect(levels[0]).toBe(7);
    expect(levels[levels.length - 1]).toBe(24);
  });

  it("formats the timer as m:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7_400)).toBe("0:07");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(300_000)).toBe("5:00");
  });

  it("recording lines depend on hold / tap", () => {
    expect(overlayLines(base, t)).toEqual(["Listening · 0:07", t.hintUndecided]);
    expect(overlayLines({ ...base, mode: "hold" }, t)[1]).toBe(t.hintHold);
    expect(overlayLines({ ...base, mode: "toggle" }, t)[1]).toBe(t.hintToggle);
  });

  it("processing phases offer Esc, results show the message (with detail)", () => {
    expect(overlayLines({ ...base, phase: "transcribing" }, t)).toEqual([t.transcribing, t.hintCancel]);
    expect(overlayLines({ ...base, phase: "cleaning" }, t)).toEqual([t.cleaning, t.hintCancel]);
    expect(overlayLines({ ...base, phase: "result", result: { ok: true, message: "inserted" } }, t)).toEqual([t.messages.inserted, ""]);
    expect(overlayLines({ ...base, phase: "result", result: { ok: false, message: "fileFailed", detail: "access denied" } }, t)[0]).toBe(
      "Could not write the file: access denied",
    );
    expect(overlayLines({ ...base, phase: "hidden" }, t)).toEqual(["", ""]);
  });

  it("has a text for every message in both languages", async () => {
    const { tr } = await import("../../../app/i18n/tr");
    for (const key of Object.keys(en.dictation.overlay.messages)) {
      expect(tr.dictation.overlay.messages[key as keyof typeof en.dictation.overlay.messages]).toBeTruthy();
    }
  });
});
