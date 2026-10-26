/**
 * Pure logic of the per-pane composer (DESIGN_SYSTEM §7.6, M4): `@` file mentions, the text
 * sent to the agent's PTY, key handling inside the composer and saved prompts.
 */
import { APP_SLUG } from "../../app/constants";
import type { SavedPrompt } from "../../lib/ipc";

/** Workspace folder of the app (`.<brand slug>`) and the one for pasted images inside it. */
export const APP_WORKSPACE_DIR = `.${APP_SLUG}`;
export const ATTACHMENTS_DIR = `${APP_WORKSPACE_DIR}/attachments`;

/** Bracketed paste markers (xterm `bracketedPasteMode`, DECSET 2004). */
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

export const SUGGESTION_LIMIT = 8;
export const MAX_SAVED_PROMPTS = 200;
export const MAX_PROMPT_TITLE_CHARS = 80;
const TITLE_FROM_TEXT_CHARS = 40;

export interface MentionQuery {
  /** Index of the `@`. */
  start: number;
  /** Text between the `@` and the caret. */
  query: string;
}

/**
 * The `@mention` being typed at `caret`: an `@` at the start or after whitespace, followed by
 * non-whitespace up to the caret. `null` when the caret is not inside one.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, query };
}

/** `@rel` as the agent reads it; paths with whitespace are quoted. */
export function mentionToken(rel: string): string {
  return /\s/.test(rel) ? `@"${rel}"` : `@${rel}`;
}

/** Replaces the mention being typed with the chosen file; the caret lands after `@rel `. */
export function applyMention(text: string, mention: MentionQuery, rel: string): { text: string; caret: number } {
  const end = mention.start + 1 + mention.query.length;
  const token = `${mentionToken(rel)} `;
  const rest = text.slice(end).replace(/^ /, "");
  return { text: text.slice(0, mention.start) + token + rest, caret: mention.start + token.length };
}

/**
 * Inserts dictated (or saved-prompt) text at the selection, with a space on either side when
 * it would otherwise run into a word.
 */
export function insertText(text: string, selStart: number, selEnd: number, inserted: string): { text: string; caret: number } {
  const piece = inserted.trim();
  if (!piece) return { text, caret: selEnd };
  const before = text.slice(0, selStart);
  const after = text.slice(selEnd);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const value = `${before}${lead}${piece}${trail}${after}`;
  return { text: value, caret: before.length + lead.length + piece.length + trail.length };
}

/** The message for the agent: the typed text followed by the attachment chips as `@path`. */
export function composeMessage(text: string, attachments: readonly string[]): string {
  const body = text.trim();
  const chips = attachments.map(mentionToken).join(" ");
  return [body, chips].filter(Boolean).join(body.includes("\n") && chips ? "\n" : " ");
}

/**
 * The bytes written to the PTY for a message (Enter is a separate write afterwards). Escape
 * and other control characters (but tab/newline) are removed so a message can never end the
 * bracketed paste early or send terminal commands; newlines become CR like xterm's paste.
 */
export function pastePayload(message: string, bracketed: boolean): string {
  const clean = message.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\n/g, "\r");
  return bracketed ? `${PASTE_START}${clean}${PASTE_END}` : clean;
}

export type ComposerKeyAction = "send" | "newline" | "next" | "previous" | "accept" | "close" | "leave" | null;

/**
 * What a key does inside the composer's own textarea (focus-scoped – the terminal never sees
 * these handlers). Enter sends, Shift+Enter is a newline, Escape hands focus back to the
 * terminal; with the `@` list open the arrows, Tab/Enter and Escape drive the list. IME
 * composition is left alone.
 */
export function composerKeyAction(
  e: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing?: boolean },
  suggestionsOpen: boolean,
): ComposerKeyAction {
  if (e.isComposing) return null;
  if (suggestionsOpen) {
    if (e.key === "ArrowDown") return "next";
    if (e.key === "ArrowUp") return "previous";
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") return "accept";
    if (e.key === "Escape") return "close";
  }
  if (e.key === "Escape" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return "leave";
  if (e.key !== "Enter" || e.ctrlKey || e.altKey || e.metaKey) return null;
  return e.shiftKey ? "newline" : "send";
}

/** Title for a prompt saved without one: its first line, clipped. */
export function titleFromText(text: string): string {
  const first = text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return first.length > TITLE_FROM_TEXT_CHARS ? `${first.slice(0, TITLE_FROM_TEXT_CHARS - 1)}…` : first;
}

/** A new saved prompt / quick command id. */
export function newPromptId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Adds a prompt to the front of the list (newest first), within the settings' limits. */
export function addSavedPrompt(list: readonly SavedPrompt[], text: string, id: string, title?: string): SavedPrompt[] {
  const body = text.trim();
  if (!body) return [...list];
  const name = (title?.trim() || titleFromText(body)).slice(0, MAX_PROMPT_TITLE_CHARS);
  return [{ id, title: name, text: body }, ...list.filter((p) => p.id !== id)].slice(0, MAX_SAVED_PROMPTS);
}

export function removeSavedPrompt(list: readonly SavedPrompt[], id: string): SavedPrompt[] {
  return list.filter((p) => p.id !== id);
}

/** Saved prompts matching a filter (title or text, case-insensitive). */
export function filterSavedPrompts(list: readonly SavedPrompt[], filter: string): SavedPrompt[] {
  const q = filter.trim().toLocaleLowerCase();
  if (!q) return [...list];
  return list.filter((p) => p.title.toLocaleLowerCase().includes(q) || p.text.toLocaleLowerCase().includes(q));
}

/** Next/previous index in a list of `count` items, wrapping around. */
export function moveIndex(index: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return 0;
  return (index + delta + count) % count;
}

/** True when a pasted `DataTransfer` carries an image (handled as an attachment). */
export function hasImage(items: ArrayLike<{ kind: string; type: string }>): boolean {
  return Array.from(items).some((item) => item.kind === "file" && item.type.startsWith("image/"));
}
