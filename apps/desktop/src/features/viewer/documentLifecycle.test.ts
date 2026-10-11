import { describe, expect, it } from "vitest";
import { diffLoadedTabs, type LoadedTabEntry } from "./documentLifecycle";

function m(entries: Array<[string, LoadedTabEntry]>): Map<string, LoadedTabEntry> {
  return new Map(entries);
}

describe("diffLoadedTabs", () => {
  it("a newly appearing tabId produces a load and nothing to release", () => {
    const previous = m([]);
    const current = m([["tab-1", { workspaceId: "ws1", rel: "a.txt" }]]);

    expect(diffLoadedTabs(previous, current)).toEqual({
      toLoad: [{ workspaceId: "ws1", rel: "a.txt" }],
      toRelease: [],
    });
  });

  it("a disappearing tabId produces a release and nothing to load", () => {
    const previous = m([["tab-1", { workspaceId: "ws1", rel: "a.txt" }]]);
    const current = m([]);

    expect(diffLoadedTabs(previous, current)).toEqual({
      toLoad: [],
      toRelease: [{ workspaceId: "ws1", rel: "a.txt" }],
    });
  });

  it("finding #4: the same tabId with a changed rel (retarget) produces neither a load nor a release", () => {
    const previous = m([["tab-1", { workspaceId: "ws1", rel: "old.txt" }]]);
    const current = m([["tab-1", { workspaceId: "ws1", rel: "new.txt" }]]);

    expect(diffLoadedTabs(previous, current)).toEqual({ toLoad: [], toRelease: [] });
  });

  it("the same tabId with the same rel is a no-op (e.g. a mode toggle re-render)", () => {
    const previous = m([["tab-1", { workspaceId: "ws1", rel: "a.txt" }]]);
    const current = m([["tab-1", { workspaceId: "ws1", rel: "a.txt" }]]);

    expect(diffLoadedTabs(previous, current)).toEqual({ toLoad: [], toRelease: [] });
  });

  it("closing a tab and opening a different (new tabId) tab for the same rel still produces one load and one release", () => {
    const previous = m([["tab-1", { workspaceId: "ws1", rel: "a.txt" }]]);
    const current = m([["tab-2", { workspaceId: "ws1", rel: "a.txt" }]]);

    expect(diffLoadedTabs(previous, current)).toEqual({
      toLoad: [{ workspaceId: "ws1", rel: "a.txt" }],
      toRelease: [{ workspaceId: "ws1", rel: "a.txt" }],
    });
  });
});
