import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { batchFsChanges } from "./fsBatch";

describe("batchFsChanges", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("handles the first event at once and merges a burst into one trailing call", () => {
    const flush = vi.fn();
    const handle = batchFsChanges(flush, 250);
    handle({ workspaceId: "ws", dirs: ["a"] });
    expect(flush).toHaveBeenCalledWith({ workspaceId: "ws", dirs: ["a"] });
    handle({ workspaceId: "ws", dirs: ["b", "a"] });
    handle({ workspaceId: "ws", dirs: ["b", "c"] });
    handle({ workspaceId: "other", dirs: ["x"] });
    expect(flush).toHaveBeenCalledTimes(2); // ws "a", other "x"
    vi.advanceTimersByTime(250);
    expect(flush).toHaveBeenCalledTimes(3);
    expect(flush).toHaveBeenLastCalledWith({ workspaceId: "ws", dirs: ["b", "a", "c"] });
    vi.advanceTimersByTime(250);
    expect(flush).toHaveBeenCalledTimes(3);
    // Quiet again: the next event is immediate.
    vi.advanceTimersByTime(250);
    handle({ workspaceId: "ws", dirs: ["d"] });
    expect(flush).toHaveBeenCalledTimes(4);
  });
});
