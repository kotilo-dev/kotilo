import { describe, expect, it } from "vitest";
import { EMPTY_ARRAY } from "./emptyArray";

describe("EMPTY_ARRAY (review #1: zustand selector infinite-loop fix)", () => {
  it("is empty", () => {
    expect(EMPTY_ARRAY).toHaveLength(0);
  });

  it("is the exact same reference across every access (module-level singleton)", () => {
    expect(EMPTY_ARRAY).toBe(EMPTY_ARRAY);
  });

  it("stays referentially stable when used as a repeated selector fallback", () => {
    // Simulates `s.foo ?? EMPTY_ARRAY` being evaluated on two consecutive renders while
    // `s.foo` stays `undefined` — the whole point of the fix is that this must be `Object.is`
    // equal, or zustand v5 / useSyncExternalStore re-renders forever.
    const selector = (state: { foo: number[] | undefined }) => state.foo ?? EMPTY_ARRAY;
    const state = { foo: undefined };
    const first = selector(state);
    const second = selector(state);
    expect(first).toBe(second);
  });
});
