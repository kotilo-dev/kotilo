import { afterEach, describe, expect, it, vi } from "vitest";
import { installMotionPause } from "./motionPause";

describe("installMotionPause", () => {
  afterEach(() => vi.restoreAllMocks());

  it("pauses while unfocused and resumes on focus", () => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const root = document.createElement("div");
    const uninstall = installMotionPause(root);
    expect(root.hasAttribute("data-motion-paused")).toBe(false);

    focus.mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    expect(root.hasAttribute("data-motion-paused")).toBe(true);

    focus.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    expect(root.hasAttribute("data-motion-paused")).toBe(false);

    uninstall();
    focus.mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    expect(root.hasAttribute("data-motion-paused")).toBe(false);
  });

  it("pauses while the document is hidden", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const root = document.createElement("div");
    const uninstall = installMotionPause(root);
    expect(root.hasAttribute("data-motion-paused")).toBe(true);
    hidden.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(root.hasAttribute("data-motion-paused")).toBe(false);
    uninstall();
  });
});
