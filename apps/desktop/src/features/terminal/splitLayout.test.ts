import { describe, expect, it } from "vitest";
import { restoreSplit, splitAfterRemove, splitBeside, splitTabToRight } from "./splitLayout";

const tabs = ["a", "b", "c"];

describe("splitTabToRight", () => {
  it("puts the tab right and keeps the active tab left", () => {
    expect(splitTabToRight(tabs, "a", "c")).toEqual({ left: "a", right: "c" });
  });

  it("uses the neighbour on the left when the active tab itself moves right", () => {
    expect(splitTabToRight(tabs, "b", "b")).toEqual({ left: "c", right: "b" });
    expect(splitTabToRight(tabs, "c", "c")).toEqual({ left: "b", right: "c" });
  });

  it("needs a second tab and a known tab", () => {
    expect(splitTabToRight(["a"], "a", "a")).toBeNull();
    expect(splitTabToRight(tabs, "a", "zz")).toBeNull();
  });
});

describe("splitBeside", () => {
  it("keeps the pane left and opens its neighbour right", () => {
    expect(splitBeside(tabs, "a")).toEqual({ left: "a", right: "b" });
    expect(splitBeside(tabs, "c")).toEqual({ left: "c", right: "b" });
    expect(splitBeside(["a"], "a")).toBeNull();
  });
});

describe("splitAfterRemove", () => {
  it("closing either half returns to a single pane", () => {
    expect(splitAfterRemove("a", "b", "b")).toEqual({ activeTabId: "a", splitTabId: null });
    expect(splitAfterRemove("a", "b", "a")).toEqual({ activeTabId: "b", splitTabId: null });
  });

  it("leaves other removals and unsplit panels to the default rule", () => {
    expect(splitAfterRemove("a", "b", "c")).toBeNull();
    expect(splitAfterRemove("a", null, "a")).toBeNull();
  });
});

describe("restoreSplit", () => {
  it("maps a valid index to its tab", () => {
    expect(restoreSplit(tabs, 0, 2)).toBe("c");
  });

  it("ignores missing, equal, out-of-range and malformed indices", () => {
    expect(restoreSplit(tabs, 0, undefined)).toBeNull();
    expect(restoreSplit(tabs, 1, 1)).toBeNull();
    expect(restoreSplit(tabs, 0, 7)).toBeNull();
    expect(restoreSplit(tabs, 0, "2")).toBeNull();
    expect(restoreSplit(tabs, 0, 1.5)).toBeNull();
  });
});
