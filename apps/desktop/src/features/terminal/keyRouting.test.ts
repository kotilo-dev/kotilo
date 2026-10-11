import { describe, expect, it } from "vitest";
import { routeKey, type KeyRoutingEvent } from "./keyRouting";

function key(partial: Partial<KeyRoutingEvent> & { key: string }): KeyRoutingEvent {
  return { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...partial };
}

describe("routeKey", () => {
  it("always routes to 'app' when the terminal isn't focused", () => {
    expect(routeKey(key({ key: "s", ctrlKey: true }), false)).toBe("app");
    expect(routeKey(key({ key: "z" }), false)).toBe("app");
  });

  it("Ctrl+B stays global (app) while the terminal is focused", () => {
    expect(routeKey(key({ key: "b", ctrlKey: true }), true)).toBe("app");
  });

  it("Ctrl+J (terminal panel toggle) is global", () => {
    expect(routeKey(key({ key: "j", ctrlKey: true }), true)).toBe("app");
  });

  it("Ctrl+Shift+U (viewer panel toggle) is global", () => {
    expect(routeKey(key({ key: "u", ctrlKey: true, shiftKey: true }), true)).toBe("app");
  });

  it("Ctrl+Tab / Ctrl+Shift+Tab are global (cycle viewer tabs even from the terminal)", () => {
    expect(routeKey(key({ key: "Tab", ctrlKey: true }), true)).toBe("app");
    expect(routeKey(key({ key: "Tab", ctrlKey: true, shiftKey: true }), true)).toBe("app");
  });

  it("Ctrl+` matches via e.code === 'Backquote' (TR keyboard produces key 'Dead')", () => {
    expect(routeKey(key({ key: "Dead", code: "Backquote", ctrlKey: true }), true)).toBe("app");
  });

  it("Ctrl+Shift+A (jump to next blocked agent) is global (faz5-spec §2.4)", () => {
    expect(routeKey(key({ key: "a", ctrlKey: true, shiftKey: true }), true)).toBe("app");
  });

  it("Ctrl+Shift+P (command palette) and Ctrl+, (settings) are global (faz6-spec §10.6)", () => {
    expect(routeKey(key({ key: "p", ctrlKey: true, shiftKey: true }), true)).toBe("app");
    expect(routeKey(key({ key: "," , ctrlKey: true }), true)).toBe("app");
  });

  it("F1 (Help) is global, even from a terminal (faz7-spec §12.2/§12.3)", () => {
    expect(routeKey(key({ key: "F1" }), true)).toBe("app");
  });

  it("Ctrl+P (quick open) is NOT global — it must reach the shell so an agent CLI's own binding works", () => {
    expect(routeKey(key({ key: "p", ctrlKey: true }), true)).toBe("shell");
  });

  it("Ctrl+Shift+C/V/F are terminal-local (handled by attachCustomKeyEventHandler, not commands.ts)", () => {
    expect(routeKey(key({ key: "c", ctrlKey: true, shiftKey: true }), true)).toBe("terminal");
    expect(routeKey(key({ key: "v", ctrlKey: true, shiftKey: true }), true)).toBe("terminal");
    expect(routeKey(key({ key: "f", ctrlKey: true, shiftKey: true }), true)).toBe("terminal");
  });

  it("Ctrl+W goes to the shell while the terminal is focused (viewer scope yields)", () => {
    expect(routeKey(key({ key: "w", ctrlKey: true }), true)).toBe("shell");
  });

  it("Ctrl+S goes to the shell while the terminal is focused", () => {
    expect(routeKey(key({ key: "s", ctrlKey: true }), true)).toBe("shell");
  });

  it("Ctrl+Shift+M goes to the shell while the terminal is focused", () => {
    expect(routeKey(key({ key: "m", ctrlKey: true, shiftKey: true }), true)).toBe("shell");
  });

  it("plain typing and Ctrl+C without a selection go to the shell", () => {
    expect(routeKey(key({ key: "a" }), true)).toBe("shell");
    expect(routeKey(key({ key: "c", ctrlKey: true }), true)).toBe("shell");
    expect(routeKey(key({ key: "c", ctrlKey: true }), true, false)).toBe("shell");
  });

  it("Ctrl+C with a selection copies; Ctrl+V always pastes (Windows Terminal behaviour)", () => {
    expect(routeKey(key({ key: "c", ctrlKey: true }), true, true)).toBe("terminal");
    expect(routeKey(key({ key: "v", ctrlKey: true }), true)).toBe("terminal");
    expect(routeKey(key({ key: "v", ctrlKey: true }), true, true)).toBe("terminal");
  });
});
