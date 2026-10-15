import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LAYOUT, mergeWithDefaults, TIMELINE_MAX_WIDTH, TIMELINE_MIN_WIDTH, useLayoutStore } from "./layoutStore";

const ipc = vi.hoisted(() => ({
  loadState: vi.fn(),
  saveStateSlice: vi.fn(),
}));

vi.mock("../lib/ipc", () => ipc);

describe("mergeWithDefaults", () => {
  it("returns defaults for undefined/empty input", () => {
    expect(mergeWithDefaults(undefined)).toEqual(DEFAULT_LAYOUT);
    expect(mergeWithDefaults({})).toEqual(DEFAULT_LAYOUT);
  });

  it("keeps valid saved fields and falls back per-field for missing/invalid ones", () => {
    const merged = mergeWithDefaults({
      leftVisible: false,
      columnSizes: { left: 30, terminal: "nope", viewer: 25 },
      // leftSplitSizes missing entirely
    });

    expect(merged).toEqual({
      leftVisible: false,
      terminalVisible: DEFAULT_LAYOUT.terminalVisible,
      viewerVisible: DEFAULT_LAYOUT.viewerVisible,
      columnSizes: { left: 30, terminal: DEFAULT_LAYOUT.columnSizes.terminal, viewer: 25 },
      leftSplitSizes: DEFAULT_LAYOUT.leftSplitSizes,
      timelineVisible: DEFAULT_LAYOUT.timelineVisible,
      timelineWidth: DEFAULT_LAYOUT.timelineWidth,
      timelineSplitSizes: DEFAULT_LAYOUT.timelineSplitSizes,
    });
  });

  it("restores the timeline rail split, or the default for a partial one", () => {
    expect(mergeWithDefaults({ timelineSplitSizes: { activity: 70, changes: 30 } }).timelineSplitSizes).toEqual({ activity: 70, changes: 30 });
    expect(mergeWithDefaults({ timelineSplitSizes: { activity: 70 } }).timelineSplitSizes).toEqual(DEFAULT_LAYOUT.timelineSplitSizes);
  });

  it("restores the timeline rail and clamps its width", () => {
    expect(mergeWithDefaults({ timelineVisible: false, timelineWidth: 9999 })).toMatchObject({
      timelineVisible: false,
      timelineWidth: TIMELINE_MAX_WIDTH,
    });
    expect(mergeWithDefaults({ timelineWidth: 10 }).timelineWidth).toBe(TIMELINE_MIN_WIDTH);
  });

  it("ignores garbage input types without throwing", () => {
    expect(mergeWithDefaults("not an object")).toEqual(DEFAULT_LAYOUT);
    expect(mergeWithDefaults(null)).toEqual(DEFAULT_LAYOUT);
    expect(mergeWithDefaults(42)).toEqual(DEFAULT_LAYOUT);
  });
});

describe("useLayoutStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ipc.loadState.mockReset().mockResolvedValue({});
    ipc.saveStateSlice.mockReset().mockResolvedValue(undefined);
    useLayoutStore.setState({ status: "loading", layout: DEFAULT_LAYOUT });
  });

  it("starts in 'loading' and becomes 'ready' with defaults after init() when state.json is empty", async () => {
    expect(useLayoutStore.getState().status).toBe("loading");

    await useLayoutStore.getState().init();

    expect(useLayoutStore.getState().status).toBe("ready");
    expect(useLayoutStore.getState().layout).toEqual(DEFAULT_LAYOUT);
  });

  it("merges persisted layout from disk on init()", async () => {
    ipc.loadState.mockResolvedValue({
      layout: { leftVisible: false, terminalVisible: false },
    });

    await useLayoutStore.getState().init();

    const { layout } = useLayoutStore.getState();
    expect(layout.leftVisible).toBe(false);
    expect(layout.terminalVisible).toBe(false);
    expect(layout.viewerVisible).toBe(DEFAULT_LAYOUT.viewerVisible);
  });

  it("falls back to defaults if load_state rejects", async () => {
    ipc.loadState.mockRejectedValue(new Error("ipc failure"));

    await useLayoutStore.getState().init();

    expect(useLayoutStore.getState().status).toBe("ready");
    expect(useLayoutStore.getState().layout).toEqual(DEFAULT_LAYOUT);
  });

  it("setVisible syncs drag-collapse into the store and is a no-op when unchanged", async () => {
    await useLayoutStore.getState().init();

    useLayoutStore.getState().setVisible("terminal", true); // already visible
    vi.advanceTimersByTime(600);
    expect(ipc.saveStateSlice).not.toHaveBeenCalled();

    useLayoutStore.getState().setVisible("terminal", false);
    expect(useLayoutStore.getState().layout.terminalVisible).toBe(false);
    expect(useLayoutStore.getState().layout.columnSizes).toEqual(DEFAULT_LAYOUT.columnSizes);
    vi.advanceTimersByTime(600);
    expect(ipc.saveStateSlice).toHaveBeenCalledTimes(1);
  });

  it("toggleLeft / toggleTerminal / toggleViewer flip only their own flag", async () => {
    await useLayoutStore.getState().init();

    useLayoutStore.getState().toggleLeft();
    expect(useLayoutStore.getState().layout.leftVisible).toBe(!DEFAULT_LAYOUT.leftVisible);
    expect(useLayoutStore.getState().layout.terminalVisible).toBe(DEFAULT_LAYOUT.terminalVisible);
    expect(useLayoutStore.getState().layout.viewerVisible).toBe(DEFAULT_LAYOUT.viewerVisible);

    useLayoutStore.getState().toggleTerminal();
    expect(useLayoutStore.getState().layout.terminalVisible).toBe(!DEFAULT_LAYOUT.terminalVisible);

    useLayoutStore.getState().toggleViewer();
    expect(useLayoutStore.getState().layout.viewerVisible).toBe(!DEFAULT_LAYOUT.viewerVisible);
  });

  it("debounces saves: rapid toggles within 500ms only persist once, with the latest value", async () => {
    await useLayoutStore.getState().init();
    ipc.saveStateSlice.mockClear();

    useLayoutStore.getState().toggleLeft();
    vi.advanceTimersByTime(100);
    useLayoutStore.getState().toggleLeft();
    vi.advanceTimersByTime(100);
    useLayoutStore.getState().toggleLeft();

    expect(ipc.saveStateSlice).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(ipc.saveStateSlice).toHaveBeenCalledTimes(1);
    const [key, saved] = ipc.saveStateSlice.mock.calls[0];
    expect(key).toBe("layout");
    expect(saved.leftVisible).toBe(!DEFAULT_LAYOUT.leftVisible);
  });
});
