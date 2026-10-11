import { beforeEach, describe, expect, it } from "vitest";
import { isOtherModalOpen, pushModalOpen, resetModalStackForTest } from "./modalStack";

describe("modalStack (faz7-spec §12.4)", () => {
  beforeEach(() => resetModalStackForTest());

  it("is empty by default", () => {
    expect(isOtherModalOpen()).toBe(false);
  });

  it("reports open while at least one push is unpopped", () => {
    const pop = pushModalOpen();
    expect(isOtherModalOpen()).toBe(true);
    pop();
    expect(isOtherModalOpen()).toBe(false);
  });

  it("supports multiple overlapping pushes (nested/stacked modals)", () => {
    const popA = pushModalOpen();
    const popB = pushModalOpen();
    expect(isOtherModalOpen()).toBe(true);
    popA();
    expect(isOtherModalOpen()).toBe(true); // B still open
    popB();
    expect(isOtherModalOpen()).toBe(false);
  });

  it("a pop function is idempotent (double-pop doesn't go negative)", () => {
    const pop = pushModalOpen();
    pop();
    pop();
    expect(isOtherModalOpen()).toBe(false);
  });
});
