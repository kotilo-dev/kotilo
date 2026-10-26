/**
 * D-066: review notes per workspace, in memory only (rule 5) – they are gone after a restart.
 */
import { create } from "zustand";
import { codeAt, reanchor, type ReviewNote } from "./reviewNotes";

interface ReviewStore {
  notes: ReviewNote[];
  add: (workspaceId: string, rel: string, lines: readonly string[], startLine: number, endLine: number, text: string) => string;
  edit: (id: string, text: string) => void;
  remove: (id: string) => void;
  setResolved: (id: string, resolved: boolean) => void;
  /** The file's working copy changed: move its notes with their lines. */
  reanchorFile: (workspaceId: string, rel: string, lines: readonly string[]) => void;
}

let counter = 0;

function newId(): string {
  counter += 1;
  return `note-${Date.now().toString(36)}-${counter}`;
}

export const useReviewStore = create<ReviewStore>((set) => ({
  notes: [],
  add: (workspaceId, rel, lines, startLine, endLine, text) => {
    const id = newId();
    const start = Math.min(startLine, endLine);
    const end = Math.max(startLine, endLine);
    const note: ReviewNote = { id, workspaceId, rel, startLine: start, endLine: end, code: codeAt(lines, start, end), text, resolved: false, outdated: false };
    set((s) => ({ notes: [...s.notes, note] }));
    return id;
  },
  edit: (id, text) => set((s) => ({ notes: s.notes.map((n) => (n.id === id ? { ...n, text } : n)) })),
  remove: (id) => set((s) => ({ notes: s.notes.filter((n) => n.id !== id) })),
  setResolved: (id, resolved) => set((s) => ({ notes: s.notes.map((n) => (n.id === id ? { ...n, resolved } : n)) })),
  reanchorFile: (workspaceId, rel, lines) =>
    set((s) => {
      let changed = false;
      const notes = s.notes.map((n) => {
        if (n.workspaceId !== workspaceId || n.rel !== rel) return n;
        const next = reanchor(n, lines);
        if (next !== n) changed = true;
        return next;
      });
      return changed ? { notes } : s;
    }),
}));

/** Notes still to send: unresolved ones of the workspace. */
export function openNotes(notes: readonly ReviewNote[], workspaceId: string): ReviewNote[] {
  return notes.filter((n) => n.workspaceId === workspaceId && !n.resolved);
}

export function useOpenNoteCount(workspaceId: string, rel?: string): number {
  return useReviewStore((s) => s.notes.filter((n) => n.workspaceId === workspaceId && !n.resolved && (rel === undefined || n.rel === rel)).length);
}
