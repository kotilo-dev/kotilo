/**
 * D-069 quick commands, pure part: saved shell commands and agent prompts, global or limited to
 * one workspace folder. They share the composer's saved-prompt list (`composer.savedPrompts`);
 * an entry without `kind` is a prompt saved before quick commands existed.
 */
import type { SavedPrompt } from "../../lib/ipc";
import { MAX_PROMPT_TITLE_CHARS, MAX_SAVED_PROMPTS, titleFromText } from "../composer/composerLogic";

export type QuickKind = "command" | "prompt";

export function kindOf(entry: Pick<SavedPrompt, "kind">): QuickKind {
  return entry.kind === "command" ? "command" : "prompt";
}

/** Folder paths compared like Windows does: separators and case ignored, no trailing slash. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
  return norm(a) === norm(b);
}

/** Whether an entry is offered in a workspace (`null` = no workspace: only global entries). */
export function appliesTo(entry: Pick<SavedPrompt, "project">, workspacePath: string | null): boolean {
  const project = entry.project?.trim() ?? "";
  if (!project) return true;
  return workspacePath !== null && samePath(project, workspacePath);
}

/** Entries offered in a workspace, optionally of one kind, in list order. */
export function quickCommandsFor(list: readonly SavedPrompt[], workspacePath: string | null, kind?: QuickKind): SavedPrompt[] {
  return list.filter((e) => appliesTo(e, workspacePath) && (kind === undefined || kindOf(e) === kind));
}

/** A shell command is one line: line breaks become spaces (the editor offers a single line). */
export function commandLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/**
 * Replaces the entry with the same id in place, or adds it to the front; within the limits. An
 * empty title becomes the text's first line.
 */
export function upsertQuickCommand(list: readonly SavedPrompt[], entry: SavedPrompt): SavedPrompt[] {
  const text = kindOf(entry) === "command" ? commandLine(entry.text) : entry.text.trim();
  const clean: SavedPrompt = {
    ...entry,
    title: (entry.title.trim() || titleFromText(text)).slice(0, MAX_PROMPT_TITLE_CHARS),
    text,
    project: entry.project?.trim() ?? "",
  };
  const at = list.findIndex((e) => e.id === entry.id);
  if (at < 0) return [clean, ...list].slice(0, MAX_SAVED_PROMPTS);
  const next = [...list];
  next[at] = clean;
  return next;
}
