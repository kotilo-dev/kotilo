import { describe, expect, it } from "vitest";
import { RequestGuard } from "./staleGuard";

describe("RequestGuard", () => {
  it("treats the first (and only) request as latest", () => {
    const guard = new RequestGuard();
    const id = guard.next();
    expect(guard.isLatest(id)).toBe(true);
  });

  it("marks an earlier request as stale once a newer one starts", () => {
    const guard = new RequestGuard();
    const first = guard.next();
    const second = guard.next();
    expect(guard.isLatest(first)).toBe(false);
    expect(guard.isLatest(second)).toBe(true);
  });

  it("keeps the latest id valid even after multiple stale requests resolve out of order", () => {
    const guard = new RequestGuard();
    const a = guard.next();
    const b = guard.next();
    const c = guard.next();
    // Simulates responses resolving out of order: only `c` (the last started) should count.
    expect(guard.isLatest(a)).toBe(false);
    expect(guard.isLatest(b)).toBe(false);
    expect(guard.isLatest(c)).toBe(true);
  });
});
