/**
 * D-066: review notes on a diff, sent to an agent. Part of `en` as `review`; `review.tr.ts` has
 * the same shape.
 */
export const reviewEn = {
  addNote: "Add review note",
  addNoteAt: (lines: string) => `Add a review note on line ${lines}`,
  placeholder: "What should the agent change here? (Enter saves, Shift+Enter for a new line, Esc cancels)",
  save: "Save",
  cancel: "Cancel",
  edit: "Edit",
  delete: "Delete",
  resolve: "Resolve",
  reopen: "Reopen",
  lines: (lines: string) => `Line ${lines}`,
  outdated: "Lines changed",
  resolved: "Resolved",
  noteCount: (n: number) => (n === 1 ? "1 note" : `${n} notes`),
  sendTo: (n: number) => (n === 1 ? "Send 1 note to…" : `Send ${n} notes to…`),
  noAgent: "No agent is running in this workspace.",
  sentTo: (agent: string) => `Notes put into ${agent}'s message field. Check them and send.`,
  hint: "Hover a line and click + (or select lines and press C) to add a review note.",
};
