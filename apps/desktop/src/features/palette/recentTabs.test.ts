import { describe, expect, it } from "vitest";
import { orderByRecency } from "./recentTabs";

describe("orderByRecency", () => {
  it("orders known tabs by recency (most recent first)", () => {
    expect(orderByRecency(["a", "b", "c"], ["c", "a"])).toEqual(["c", "a", "b"]);
  });

  it("places tabs never activated after the known ones, keeping their relative order", () => {
    expect(orderByRecency(["a", "b", "c", "d"], ["c"])).toEqual(["c", "a", "b", "d"]);
  });

  it("returns the original order unchanged when nothing has recency data", () => {
    expect(orderByRecency(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
  });

  it("ignores recency entries for tabs that are no longer open", () => {
    expect(orderByRecency(["a", "b"], ["z", "b", "a"])).toEqual(["b", "a"]);
  });
});
