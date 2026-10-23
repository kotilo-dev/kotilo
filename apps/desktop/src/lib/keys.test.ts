import { afterEach, describe, expect, it } from "vitest";
import { formatKeybinding, isMac, isModPressed, resolveKeybinding } from "./keys";
import { setPlatformForTests } from "./platform";
import { normalizeKeybinding } from "../app/commands";
import { en } from "../app/i18n/en";
import { tr } from "../app/i18n/tr";

afterEach(() => setPlatformForTests("windows"));

describe("resolveKeybinding", () => {
  it("is the old Ctrl string on Windows and Linux", () => {
    for (const platform of ["windows", "linux"]) {
      expect(resolveKeybinding("Mod+B", platform)).toBe("Ctrl+B");
      expect(resolveKeybinding("Mod+Shift+P", platform)).toBe("Ctrl+Shift+P");
      expect(resolveKeybinding("Mod+,", platform)).toBe("Ctrl+,");
      expect(resolveKeybinding("Ctrl+Tab", platform)).toBe("Ctrl+Tab");
      expect(resolveKeybinding("Alt+3", platform)).toBe("Alt+3");
      expect(resolveKeybinding("F1", platform)).toBe("F1");
    }
  });

  it("maps Mod to Cmd (Meta) on macOS in normalizeKeybinding's order; literal Ctrl stays", () => {
    expect(resolveKeybinding("Mod+B", "macos")).toBe("Meta+B");
    expect(resolveKeybinding("Mod+Shift+P", "macos")).toBe("Shift+Meta+P");
    expect(resolveKeybinding("Ctrl+Shift+Tab", "macos")).toBe("Ctrl+Shift+Tab");
    expect(resolveKeybinding("Ctrl+`", "macos")).toBe("Ctrl+`");
  });

  it("matches the combo of the real key event on each OS", () => {
    const cmdShiftP = { ctrlKey: false, shiftKey: true, altKey: false, metaKey: true, key: "P", code: "KeyP" };
    expect(normalizeKeybinding(cmdShiftP)).toBe(resolveKeybinding("Mod+Shift+P", "macos"));
    const ctrlShiftP = { ...cmdShiftP, ctrlKey: true, metaKey: false };
    expect(normalizeKeybinding(ctrlShiftP)).toBe(resolveKeybinding("Mod+Shift+P", "windows"));
  });
});

describe("normalizeKeybinding digits", () => {
  it("Option+digit on macOS matches on e.code (it types '¡')", () => {
    expect(normalizeKeybinding({ ctrlKey: false, shiftKey: false, altKey: true, metaKey: false, key: "¡", code: "Digit1" })).toBe("Alt+1");
  });

  it("Alt+digit on Windows is unchanged", () => {
    expect(normalizeKeybinding({ ctrlKey: false, shiftKey: false, altKey: true, metaKey: false, key: "4", code: "Digit4" })).toBe("Alt+4");
  });
});

describe("formatKeybinding", () => {
  it("is the Ctrl label on Windows/Linux", () => {
    expect(formatKeybinding("Mod+Shift+P", "windows")).toBe("Ctrl+Shift+P");
    expect(formatKeybinding("Mod+1", "linux")).toBe("Ctrl+1");
    expect(formatKeybinding("Mod", "windows")).toBe("Ctrl");
  });

  it("uses Apple's symbols and order on macOS", () => {
    expect(formatKeybinding("Mod+Shift+P", "macos")).toBe("⇧⌘P");
    expect(formatKeybinding("Mod+,", "macos")).toBe("⌘,");
    expect(formatKeybinding("Alt+2", "macos")).toBe("⌥2");
    expect(formatKeybinding("Ctrl+Tab", "macos")).toBe("⌃Tab");
    expect(formatKeybinding("Mod", "macos")).toBe("⌘");
  });

  it("follows the hydrated platform by default", () => {
    setPlatformForTests("macos");
    expect(isMac()).toBe(true);
    expect(formatKeybinding("Mod+F")).toBe("⌘F");
    setPlatformForTests("windows");
    expect(formatKeybinding("Mod+F")).toBe("Ctrl+F");
  });
});

describe("isModPressed", () => {
  it("is Ctrl on Windows/Linux and Cmd on macOS", () => {
    expect(isModPressed({ ctrlKey: true, metaKey: false }, "windows")).toBe(true);
    expect(isModPressed({ ctrlKey: false, metaKey: true }, "windows")).toBe(false);
    expect(isModPressed({ ctrlKey: false, metaKey: true }, "macos")).toBe(true);
    expect(isModPressed({ ctrlKey: true, metaKey: false }, "macos")).toBe(false);
  });
});

describe("OS-dependent copy", () => {
  it("keeps the Windows text on Windows", () => {
    expect(en.contextMenu.revealInExplorer).toBe("Reveal in Explorer");
    expect(en.settings.appearance.languageSystem).toBe("Same as Windows");
    expect(en.viewer.pdf.searchTooltip).toBe("Find (Ctrl+F)");
    expect(en.terminal.ctrlClickToOpenLink).toBe("Ctrl+click to open in browser");
  });

  it("names Finder, macOS and Cmd on macOS (en + tr)", () => {
    setPlatformForTests("macos");
    expect(en.contextMenu.revealInExplorer).toBe("Reveal in Finder");
    expect(en.contextMenu.openInExplorer).toBe("Open in Finder");
    expect(en.settings.appearance.languageSystem).toBe("Same as macOS");
    expect(en.viewer.pdf.searchTooltip).toBe("Find (⌘F)");
    expect(en.terminal.ctrlClickToOpenFile).toBe("⌘-click to open");
    expect(tr.contextMenu.revealInExplorer).toBe("Finder'da göster");
    expect(tr.viewer.pdf.searchTooltip).toBe("Bul (⌘F)");
    for (const dict of [en, tr]) {
      expect(dict.ai.apiKeyHint).not.toMatch(/Windows/);
      expect(dict.settings.appearance.themeSystemHint).not.toMatch(/Windows/);
    }
  });

  it("does not mention Windows or Explorer on Linux", () => {
    setPlatformForTests("linux");
    expect(en.contextMenu.revealInExplorer).toBe("Show in file manager");
    expect(tr.settings.appearance.languageSystem).toBe("Sistemle aynı");
    expect(en.ai.apiKeyHint).not.toMatch(/Windows/);
  });
});
