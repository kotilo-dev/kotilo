/**
 * U-3: the app's primary shortcut modifier ("Mod") – Cmd on macOS, Ctrl on Windows and Linux.
 *
 * Keybindings are written in a canonical form (`"Mod+Shift+P"`, `"Ctrl+Tab"`, `"Alt+1"`):
 * `Mod` follows the platform, a literal `Ctrl` stays Ctrl everywhere (macOS reserves Cmd+Tab and
 * Cmd+`, so those few keep Ctrl). `resolveKeybinding` turns a binding into the physical combo
 * `normalizeKeybinding` produces for a key event; on Windows/Linux the result is byte-identical
 * to the old "Ctrl+…" strings. `formatKeybinding` gives the label users see.
 */
import { platformId } from "./platform";

export function isMac(platform: string = platformId()): boolean {
  return platform === "macos";
}

/** Whether the platform's primary modifier is held (Cmd on macOS – Ctrl+click is a right click there). */
export function isModPressed(e: { ctrlKey: boolean; metaKey: boolean }, platform: string = platformId()): boolean {
  return isMac(platform) ? e.metaKey : e.ctrlKey;
}

/** Physical modifiers in the order `normalizeKeybinding` writes them. */
const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

function parse(binding: string, platform: string): { mods: Set<Modifier>; key: string } {
  const parts = binding.split("+");
  // "Ctrl++" style bindings do not exist; a trailing empty part would be a "+" key.
  const key = parts.pop() ?? "";
  const mods = new Set<Modifier>();
  for (const part of parts) {
    if (part === "Mod") mods.add(isMac(platform) ? "Meta" : "Ctrl");
    else if ((MODIFIER_ORDER as readonly string[]).includes(part)) mods.add(part as Modifier);
  }
  return { mods, key };
}

/** Canonical binding → the combo string `normalizeKeybinding` yields on `platform`. */
export function resolveKeybinding(binding: string, platform: string = platformId()): string {
  const { mods, key } = parse(binding, platform);
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join("+");
}

/** Apple's modifier order and symbols (⌃⌥⇧⌘). */
const MAC_SYMBOLS: Record<Modifier, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };

/**
 * The label for a binding: unchanged "Ctrl+Shift+P" on Windows/Linux, "⇧⌘P" on macOS.
 * A bare `"Mod"` yields "Ctrl" / "⌘".
 */
export function formatKeybinding(binding: string, platform: string = platformId()): string {
  if (binding === "Mod") return isMac(platform) ? MAC_SYMBOLS.Meta : "Ctrl";
  if (!isMac(platform)) return resolveKeybinding(binding, platform);
  const { mods, key } = parse(binding, platform);
  return (
    MODIFIER_ORDER.filter((m) => mods.has(m))
      .map((m) => MAC_SYMBOLS[m])
      .join("") + key
  );
}
