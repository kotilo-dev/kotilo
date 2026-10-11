import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateProgress } from "../../lib/ipc";

const ipc = vi.hoisted(() => ({
  updateCheck: vi.fn(),
  updateInstall: vi.fn(),
  onUpdateProgress: vi.fn(),
  onUpdateReady: vi.fn(),
  progressHandler: null as ((p: UpdateProgress) => void) | null,
  readyHandler: null as (() => void) | null,
  unlistenProgress: vi.fn(),
  unlistenReady: vi.fn(),
}));
const logging = vi.hoisted(() => ({ logWarn: vi.fn() }));

vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return {
    ...actual,
    updateCheck: ipc.updateCheck,
    updateInstall: ipc.updateInstall,
    onUpdateProgress: ipc.onUpdateProgress,
    onUpdateReady: ipc.onUpdateReady,
    settingsSet: vi.fn().mockImplementation((s: unknown) => Promise.resolve(s)),
  };
});
vi.mock("../../lib/logging", () => logging);

import { resetSettingsStoreForTest, useSettingsStore } from "../../stores/settingsStore";
import {
  checkOnStartEnabled,
  resetUpdateStoreForTest,
  scheduleStartupUpdateCheck,
  STARTUP_CHECK_DELAY_MS,
  useUpdateStore,
} from "./updateStore";

const AVAILABLE = { status: "available", current: "0.1.0", version: "0.2.0", notes: "Fixes", date: "2026-10-09" } as const;

beforeEach(() => {
  resetUpdateStoreForTest();
  resetSettingsStoreForTest();
  ipc.updateCheck.mockReset();
  ipc.updateInstall.mockReset();
  ipc.unlistenProgress.mockReset();
  ipc.unlistenReady.mockReset();
  logging.logWarn.mockReset();
  ipc.onUpdateProgress.mockReset().mockImplementation((h: (p: UpdateProgress) => void) => {
    ipc.progressHandler = h;
    return Promise.resolve(ipc.unlistenProgress);
  });
  ipc.onUpdateReady.mockReset().mockImplementation((h: () => void) => {
    ipc.readyHandler = h;
    return Promise.resolve(ipc.unlistenReady);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkNow (About)", () => {
  it("goes checking → done and keeps the result", async () => {
    let resolve!: (v: unknown) => void;
    ipc.updateCheck.mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = useUpdateStore.getState().checkNow();
    expect(useUpdateStore.getState().check).toEqual({ phase: "checking" });
    resolve({ status: "up-to-date", current: "0.1.0" });
    await pending;
    expect(useUpdateStore.getState().check).toEqual({ phase: "done", result: { status: "up-to-date", current: "0.1.0" } });
    expect(useUpdateStore.getState().prompt).toBeNull();
  });

  it("opens the prompt when an update is available", async () => {
    ipc.updateCheck.mockResolvedValue(AVAILABLE);
    await useUpdateStore.getState().checkNow();
    expect(useUpdateStore.getState().prompt).toEqual(AVAILABLE);
  });

  it("turns a rejected IPC call into an error result instead of throwing", async () => {
    ipc.updateCheck.mockRejectedValue({ code: "io", message: "offline" });
    const result = await useUpdateStore.getState().checkNow();
    expect(result).toEqual({ status: "error", message: "offline" });
    expect(useUpdateStore.getState().check).toEqual({ phase: "done", result });
  });

  it("joins a check that is already running", async () => {
    ipc.updateCheck.mockResolvedValue({ status: "not-configured" });
    const a = useUpdateStore.getState().checkNow();
    const b = useUpdateStore.getState().checkNow();
    await Promise.all([a, b]);
    expect(ipc.updateCheck).toHaveBeenCalledTimes(1);
  });
});

describe("startup check", () => {
  it("runs once after the delay when enabled and opens the prompt for an update", async () => {
    vi.useFakeTimers();
    ipc.updateCheck.mockResolvedValue(AVAILABLE);
    scheduleStartupUpdateCheck();
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS - 1);
    expect(ipc.updateCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ipc.updateCheck).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().prompt).toEqual(AVAILABLE);
  });

  it("is silent for not-configured (no prompt) but About still sees the result", async () => {
    ipc.updateCheck.mockResolvedValue({ status: "not-configured" });
    await useUpdateStore.getState().checkOnStart();
    expect(useUpdateStore.getState().prompt).toBeNull();
    expect(useUpdateStore.getState().check).toEqual({ phase: "done", result: { status: "not-configured" } });
  });

  it("only logs a failed check", async () => {
    ipc.updateCheck.mockResolvedValue({ status: "error", message: "timeout" });
    await useUpdateStore.getState().checkOnStart();
    expect(useUpdateStore.getState().prompt).toBeNull();
    expect(logging.logWarn).toHaveBeenCalledWith(expect.stringContaining("timeout"));
  });

  it("does not run when the setting is off, and the cleanup cancels it", async () => {
    vi.useFakeTimers();
    useSettingsStore.getState().update({ updates: { checkOnStart: false } });
    expect(checkOnStartEnabled()).toBe(false);
    scheduleStartupUpdateCheck();
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS);
    expect(ipc.updateCheck).not.toHaveBeenCalled();

    useSettingsStore.getState().update({ updates: { checkOnStart: true } });
    const cancel = scheduleStartupUpdateCheck();
    cancel();
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS);
    expect(ipc.updateCheck).not.toHaveBeenCalled();
  });

  it("treats a missing `updates` section (older settings) as on", () => {
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, updates: undefined } });
    expect(checkOnStartEnabled()).toBe(true);
  });
});

describe("installUpdate", () => {
  it("tracks progress events, ends in ready and unsubscribes", async () => {
    let finish!: () => void;
    ipc.updateInstall.mockReturnValue(new Promise<void>((r) => (finish = r)));
    useUpdateStore.setState({ prompt: AVAILABLE });
    const running = useUpdateStore.getState().installUpdate();
    await vi.waitFor(() => expect(ipc.progressHandler).not.toBeNull());
    expect(useUpdateStore.getState().install).toEqual({ phase: "downloading", downloaded: 0, total: null });

    ipc.progressHandler!({ downloaded: 500, total: 1000 });
    expect(useUpdateStore.getState().install).toEqual({ phase: "downloading", downloaded: 500, total: 1000 });
    ipc.readyHandler!();
    expect(useUpdateStore.getState().install).toEqual({ phase: "ready" });
    // A late progress event does not move it back.
    ipc.progressHandler!({ downloaded: 1000, total: 1000 });
    expect(useUpdateStore.getState().install).toEqual({ phase: "ready" });

    finish();
    await running;
    expect(ipc.unlistenProgress).toHaveBeenCalled();
    expect(ipc.unlistenReady).toHaveBeenCalled();
  });

  it("shows a rejected install (message string) as an error state", async () => {
    ipc.updateInstall.mockRejectedValue("signature mismatch");
    useUpdateStore.setState({ prompt: AVAILABLE });
    await useUpdateStore.getState().installUpdate();
    expect(useUpdateStore.getState().install).toEqual({ phase: "error", message: "signature mismatch" });
    expect(ipc.unlistenProgress).toHaveBeenCalled();
  });

  it("ignores a second install while one runs, and Later cannot dismiss a running download", async () => {
    ipc.updateInstall.mockReturnValue(new Promise<void>(() => {}));
    useUpdateStore.setState({ prompt: AVAILABLE });
    void useUpdateStore.getState().installUpdate();
    void useUpdateStore.getState().installUpdate();
    await vi.waitFor(() => expect(ipc.updateInstall).toHaveBeenCalledTimes(1));
    useUpdateStore.getState().dismissPrompt();
    expect(useUpdateStore.getState().prompt).toEqual(AVAILABLE);
  });

  it("Later clears the prompt and a failed install state", () => {
    useUpdateStore.setState({ prompt: AVAILABLE, install: { phase: "error", message: "x" } });
    useUpdateStore.getState().dismissPrompt();
    expect(useUpdateStore.getState().prompt).toBeNull();
    expect(useUpdateStore.getState().install).toEqual({ phase: "idle" });
  });
});
