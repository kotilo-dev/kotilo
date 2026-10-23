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

describe("routeKey on macOS (U-3)", () => {
  const mac = (e: KeyRoutingEvent, hasSelection = false) => routeKey(e, true, hasSelection, "macos");

  it("app shortcuts use Cmd; the same Ctrl combos go to the shell", () => {
    expect(mac(key({ key: "b", metaKey: true }))).toBe("app");
    expect(mac(key({ key: "j", metaKey: true }))).toBe("app");
    expect(mac(key({ key: "p", metaKey: true, shiftKey: true }))).toBe("app");
    expect(mac(key({ key: ",", metaKey: true }))).toBe("app");
    expect(mac(key({ key: "3", metaKey: true }))).toBe("app");
    expect(mac(key({ key: "b", ctrlKey: true }))).toBe("shell");
    expect(mac(key({ key: "p", ctrlKey: true, shiftKey: true }))).toBe("shell");
  });

  it("Ctrl+Tab and Ctrl+` keep Ctrl (Cmd+Tab / Cmd+` belong to macOS)", () => {
    expect(mac(key({ key: "Tab", ctrlKey: true }))).toBe("app");
    expect(mac(key({ key: "Tab", ctrlKey: true, shiftKey: true }))).toBe("app");
    expect(mac(key({ key: "`", code: "Backquote", ctrlKey: true }))).toBe("app");
  });

  it("Cmd+C copies (with or without a selection), Cmd+V pastes, Cmd+F finds", () => {
    expect(mac(key({ key: "c", metaKey: true }), true)).toBe("terminal");
    expect(mac(key({ key: "c", metaKey: true }), false)).toBe("terminal");
    expect(mac(key({ key: "v", metaKey: true }))).toBe("terminal");
    expect(mac(key({ key: "f", metaKey: true }))).toBe("terminal");
    expect(mac(key({ key: "v", metaKey: true, shiftKey: true }))).toBe("terminal");
  });

  it("Ctrl+C and Ctrl+V always reach the shell, even with a selection", () => {
    expect(mac(key({ key: "c", ctrlKey: true }), true)).toBe("shell");
    expect(mac(key({ key: "c", ctrlKey: true }), false)).toBe("shell");
    expect(mac(key({ key: "v", ctrlKey: true }))).toBe("shell");
    expect(mac(key({ key: "f", ctrlKey: true }))).toBe("shell");
  });

  it("Option+digit switches routes by e.code although it types a character", () => {
    expect(mac(key({ key: "¡", code: "Digit1", altKey: true }))).toBe("app");
    expect(mac(key({ key: "™", code: "Digit2", altKey: true }))).toBe("app");
  });
});

describe("routeKey on Windows/Linux stays as before (U-3)", () => {
  it.each(["windows", "linux"])("%s: Ctrl shortcuts, Ctrl+C only with a selection, Cmd/Meta goes to the shell", (platform) => {
    const r = (e: KeyRoutingEvent, sel = false) => routeKey(e, true, sel, platform);
    expect(r(key({ key: "b", ctrlKey: true }))).toBe("app");
    expect(r(key({ key: "c", ctrlKey: true }), true)).toBe("terminal");
    expect(r(key({ key: "c", ctrlKey: true }), false)).toBe("shell");
    expect(r(key({ key: "v", ctrlKey: true }))).toBe("terminal");
    expect(r(key({ key: "f", ctrlKey: true }))).toBe("shell");
    expect(r(key({ key: "f", ctrlKey: true, shiftKey: true }))).toBe("terminal");
    expect(r(key({ key: "b", metaKey: true }))).toBe("shell");
    expect(r(key({ key: "1", code: "Digit1", altKey: true }))).toBe("app");
  });
});
