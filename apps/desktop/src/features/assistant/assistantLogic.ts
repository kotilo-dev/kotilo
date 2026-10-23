/**
 * Pure helpers of the assistant popup (M7): keyboard mapping, footer variant and error texts.
 */
import type { Strings } from "../../app/i18n";
import { isMac } from "../../lib/keys";

export type KeyAction = "send" | "stop" | "close" | "editLast" | "newChat";

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** IME composition in progress: Enter confirms the candidate, it doesn't send. */
  isComposing?: boolean;
}

export interface KeyContext {
  running: boolean;
  /** The key went to the composer textarea. */
  inComposer: boolean;
  composerEmpty: boolean;
}

/** What a key press does in the popup (null = leave it to the browser). */
export function keyAction(e: KeyLike, ctx: KeyContext): KeyAction | null {
  if (e.isComposing) return null;
  const plain = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
  if (e.key === "Escape" && plain) return ctx.running ? "stop" : "close";
  // Ctrl+N (Cmd+N on macOS).
  const modOnly = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if ((e.key === "n" || e.key === "N") && modOnly && !e.shiftKey && !e.altKey) return "newChat";
  if (!ctx.inComposer) return null;
  if (e.key === "Enter" && plain) return "send";
  if (e.key === "ArrowUp" && plain && ctx.composerEmpty && !ctx.running) return "editLast";
  return null;
}

export type FooterVariant = "ephemeral" | "keeps" | "mayKeep";

export function footerVariant(ephemeral: boolean | null | undefined): FooterVariant {
  if (ephemeral === true) return "ephemeral";
  if (ephemeral === false) return "keeps";
  return "mayKeep";
}

type T = Strings["assistant"];

/** Error kinds whose fix lives in Settings → AI (the turn shows a button to go there). */
const SETTINGS_KINDS = new Set(["notInstalled", "notLoggedIn", "notConfigured", "unauthorized", "unreachable", "disabled"]);

export function needsSettings(kind: string | null): boolean {
  return kind !== null && SETTINGS_KINDS.has(kind);
}

export function errorText(t: T, kind: string | null, error: string | null): string {
  const known = kind !== null && Object.prototype.hasOwnProperty.call(t.errors, kind) ? t.errors[kind as keyof T["errors"]] : null;
  // `invalid` carries the hub's own message.
  if (known) return kind === "invalid" && error ? `${known} ${error}` : known;
  return error ? t.errorGeneric(error) : t.errorGenericNoDetail;
}
