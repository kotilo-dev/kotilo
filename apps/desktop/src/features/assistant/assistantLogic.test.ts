import { describe, expect, it } from "vitest";
import { dictionary } from "../../app/i18n";
import { errorText, footerVariant, keyAction, needsSettings, type KeyLike } from "./assistantLogic";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods });
const idle = { running: false, inComposer: true, composerEmpty: false };

describe("keyAction", () => {
  it("Enter sends, Shift+Enter is left to the textarea, IME Enter is ignored", () => {
    expect(keyAction(key("Enter"), idle)).toBe("send");
    expect(keyAction(key("Enter", { shiftKey: true }), idle)).toBeNull();
    expect(keyAction(key("Enter", { isComposing: true }), idle)).toBeNull();
    expect(keyAction(key("Enter"), { ...idle, inComposer: false })).toBeNull();
  });

  it("Esc stops a running answer, otherwise closes", () => {
    expect(keyAction(key("Escape"), { ...idle, running: true })).toBe("stop");
    expect(keyAction(key("Escape"), idle)).toBe("close");
    expect(keyAction(key("Escape"), { ...idle, inComposer: false })).toBe("close");
  });

  it("Ctrl+N starts a new chat anywhere", () => {
    expect(keyAction(key("n", { ctrlKey: true }), { ...idle, inComposer: false })).toBe("newChat");
    expect(keyAction(key("N", { ctrlKey: true }), idle)).toBe("newChat");
    expect(keyAction(key("n", { ctrlKey: true, shiftKey: true }), idle)).toBeNull();
    expect(keyAction(key("n"), idle)).toBeNull();
  });

  it("↑ edits the last message only in an empty composer and not while running", () => {
    expect(keyAction(key("ArrowUp"), { ...idle, composerEmpty: true })).toBe("editLast");
    expect(keyAction(key("ArrowUp"), idle)).toBeNull();
    expect(keyAction(key("ArrowUp"), { ...idle, composerEmpty: true, running: true })).toBeNull();
    expect(keyAction(key("ArrowUp", { shiftKey: true }), { ...idle, composerEmpty: true })).toBeNull();
  });
});

describe("footerVariant", () => {
  it("maps the provider's persistence", () => {
    expect(footerVariant(true)).toBe("ephemeral");
    expect(footerVariant(false)).toBe("keeps");
    expect(footerVariant(null)).toBe("mayKeep");
    expect(footerVariant(undefined)).toBe("mayKeep");
  });
});

describe("errorText", () => {
  const t = dictionary("en").assistant;
  it("localizes known kinds and falls back to the detail", () => {
    expect(errorText(t, "timeout", "x")).toBe(t.errors.timeout);
    expect(errorText(dictionary("tr").assistant, "busy", null)).toBe(dictionary("tr").assistant.errors.busy);
    expect(errorText(t, "somethingNew", "exit code 3")).toBe(t.errorGeneric("exit code 3"));
    expect(errorText(t, "ipc", null)).toBe(t.errorGenericNoDetail);
    expect(errorText(t, "invalid", "Too many messages.")).toBe(`${t.errors.invalid} Too many messages.`);
    for (const kind of ["notInstalled", "notLoggedIn", "unreachable", "unauthorized", "timeout", "failed", "cancelled", "notConfigured", "busy", "disabled", "invalid", "hubUnavailable"]) {
      expect(errorText(t, kind, null)).toBe(t.errors[kind as keyof typeof t.errors]);
    }
    expect(errorText(t, "toString", null)).toBe(t.errorGenericNoDetail);
  });

  it("sends configuration errors to Settings → AI", () => {
    expect(needsSettings("notInstalled")).toBe(true);
    expect(needsSettings("notLoggedIn")).toBe(true);
    expect(needsSettings("timeout")).toBe(false);
    expect(needsSettings(null)).toBe(false);
  });
});

describe("assistant strings", () => {
  it("EN and TR have the same keys", () => {
    const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" && v !== null ? keys(v).map((x) => `${k}.${x}`) : [k])).sort();
    expect(keys(dictionary("tr").assistant)).toEqual(keys(dictionary("en").assistant));
  });
});
