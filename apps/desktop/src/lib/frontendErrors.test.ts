import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  warn: vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-log", () => plugin);

import { installFrontendErrorHandlers } from "./frontendErrors";
import { resetLoggingForTest } from "./logging";

/** A scoped EventTarget standing in for `window` — keeps each test's listeners isolated. */
function fakeWindow(): Window {
  const target = new EventTarget() as unknown as Window & { __agenthubErrorsInstalled?: boolean };
  return target;
}

describe("installFrontendErrorHandlers (faz7-spec §9.3)", () => {
  beforeEach(() => {
    resetLoggingForTest();
    plugin.warn.mockClear();
    plugin.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is idempotent: installing twice on the same target registers listeners once", () => {
    const win = fakeWindow();
    installFrontendErrorHandlers(win);
    installFrontendErrorHandlers(win);
    win.dispatchEvent(Object.assign(new Event("error"), { message: "boom", filename: "a.ts", lineno: 1 }));
    expect(plugin.error).toHaveBeenCalledTimes(1);
  });

  it("logs a window 'error' event as `[frontend] <message> at <file>:<line>`", () => {
    const win = fakeWindow();
    installFrontendErrorHandlers(win);
    win.dispatchEvent(Object.assign(new Event("error"), { message: "boom", filename: "a.ts", lineno: 42 }));
    expect(plugin.error).toHaveBeenCalledWith("[frontend] boom at a.ts:42");
  });

  it("uses the serialized `error` object (name/message/stack) when present", () => {
    const win = fakeWindow();
    installFrontendErrorHandlers(win);
    const err = new Error("real error");
    err.stack = "Error: real error\n    at x (a.ts:1:1)";
    win.dispatchEvent(Object.assign(new Event("error"), { message: "boom", filename: "a.ts", lineno: 1, error: err }));
    const [message] = plugin.error.mock.calls[0] as [string];
    expect(message).toContain("Error: real error");
    expect(message).toContain("at a.ts:1");
  });

  it("logs an unhandledrejection as `[frontend] unhandled rejection: <serialized reason>`", () => {
    const win = fakeWindow();
    installFrontendErrorHandlers(win);
    win.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: { code: "io", message: "disk full" } }));
    expect(plugin.error).toHaveBeenCalledWith("[frontend] unhandled rejection: io: disk full");
  });

  it("ignores an 'error' event whose message mentions plugin:log (loop prevention)", () => {
    const win = fakeWindow();
    installFrontendErrorHandlers(win);
    win.dispatchEvent(
      Object.assign(new Event("error"), { message: "plugin:log|log invocation failed", filename: "a.ts", lineno: 1 }),
    );
    expect(plugin.error).not.toHaveBeenCalled();
  });

  it("ignores an unhandledrejection reason mentioning plugin:log", () => {
    const win = fakeWindow();
    installFrontendErrorHandlers(win);
    win.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), {
        reason: { code: "io", message: "plugin:log|log call failed" },
      }),
    );
    expect(plugin.error).not.toHaveBeenCalled();
  });

  it("dedupes the same error message within 5s (shared flood guard)", () => {
    vi.useFakeTimers();
    const win = fakeWindow();
    installFrontendErrorHandlers(win);
    win.dispatchEvent(Object.assign(new Event("error"), { message: "boom", filename: "a.ts", lineno: 1 }));
    win.dispatchEvent(Object.assign(new Event("error"), { message: "boom", filename: "a.ts", lineno: 1 }));
    expect(plugin.error).toHaveBeenCalledTimes(1);
  });
});
