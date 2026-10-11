import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  warn: vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-log", () => plugin);

import { dedupeMapSizeForTest, logError, logWarn, oneLineMessage, resetLoggingForTest, serializeError } from "./logging";

describe("serializeError (faz7-spec §9.3)", () => {
  it("serializes an AppError-shaped value as `code: message`", () => {
    expect(serializeError({ code: "not_found", message: "no such file" })).toBe("not_found: no such file");
  });

  it("serializes a real Error as `name: message` plus the first 10 stack lines", () => {
    const err = new Error("boom");
    err.stack = ["Error: boom", ...Array.from({ length: 15 }, (_, i) => `    at frame${i} (file.ts:${i}:1)`)].join("\n");
    const out = serializeError(err);
    expect(out.startsWith("Error: boom\n")).toBe(true);
    expect(out.split("\n")).toHaveLength(11); // "Error: boom" (name:message line) + 10 stack lines
    expect(out).not.toContain("frame10");
  });

  it("serializes anything else as JSON, clipped to 500 chars", () => {
    const big = { data: "x".repeat(1000) };
    const out = serializeError(big);
    expect(out.length).toBe(500);
    expect(out.startsWith('{"data":"xxx')).toBe(true);
  });

  it("falls back to String() when JSON.stringify throws (circular structure)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializeError(circular)).not.toThrow();
  });
});

describe("oneLineMessage", () => {
  it("never contains a newline for an Error with a multi-line stack", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at somewhere (file.ts:1:1)";
    expect(oneLineMessage(err)).toBe("Error: boom");
  });

  it("uses code: message for an AppError-shaped value", () => {
    expect(oneLineMessage({ code: "io", message: "disk full" })).toBe("io: disk full");
  });
});

describe("flood guard (faz7-spec §9.3/§9.5: same guard shared by frontendErrors.ts and ipc.ts)", () => {
  beforeEach(() => {
    resetLoggingForTest();
    plugin.warn.mockClear();
    plugin.error.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.__agenthubCrashed;
  });

  it("logs the same message only once within a 5s window", () => {
    logWarn("[ipc] fs_read_dir failed: io boom");
    logWarn("[ipc] fs_read_dir failed: io boom");
    expect(plugin.warn).toHaveBeenCalledTimes(1);
  });

  it("logs again once 5s have passed", () => {
    logWarn("repeat me");
    vi.advanceTimersByTime(5001);
    logWarn("repeat me");
    expect(plugin.warn).toHaveBeenCalledTimes(2);
  });

  it("does not dedupe distinct messages", () => {
    logError("one");
    logError("two");
    expect(plugin.error).toHaveBeenCalledTimes(2);
  });

  it("caps at 100 lines once window.__agenthubCrashed is set", () => {
    window.__agenthubCrashed = true;
    for (let i = 0; i < 120; i++) {
      logError(`line ${i}`);
    }
    expect(plugin.error).toHaveBeenCalledTimes(100);
  });

  it("does not cap lines before a crash has been recorded", () => {
    for (let i = 0; i < 120; i++) {
      logError(`uncrashed line ${i}`);
    }
    expect(plugin.error).toHaveBeenCalledTimes(120);
  });

  it("prunes dedupe entries already outside the window once the map exceeds 500 entries", () => {
    for (let i = 0; i < 500; i++) {
      logWarn(`old message ${i}`);
    }
    expect(dedupeMapSizeForTest()).toBe(500);

    vi.advanceTimersByTime(5001); // every entry above is now outside the dedupe window
    logWarn("new message crosses the 500 threshold"); // 501st entry triggers the prune

    // The 500 stale entries are swept out; only the just-logged one survives.
    expect(dedupeMapSizeForTest()).toBe(1);
  });

  it("never prunes an entry that is still within its dedupe window", () => {
    for (let i = 0; i < 500; i++) {
      logWarn(`recent message ${i}`);
    }
    logWarn("new message crosses the 500 threshold");
    // No time has passed -- every one of the 500 prior entries is still within the
    // dedupe window, so the prune sweep must leave all 501 entries in place.
    expect(dedupeMapSizeForTest()).toBe(501);
  });
});
