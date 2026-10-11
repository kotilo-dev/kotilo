/**
 * Per-pane composer (DESIGN_SYSTEM §7.6) and split pane (§7.3), M4 wave 2. Part of `en` as
 * `composer`; `composer.tr.ts` has the same shape.
 */
import { APP_SLUG } from "../constants";

export const composerEn = {
  region: (agent: string) => `Message ${agent}`,
  placeholder: "Message the agent… @ to mention a file",
  hint: "Enter to send · Shift+Enter for a new line",
  send: "Send (Enter)",
  dictate: "Dictate into the message",
  stopDictation: "Stop dictation",
  transcribing: "Transcribing…",
  files: "Files",
  noMatches: "No matching files",
  removeAttachment: (path: string) => `Remove ${path}`,
  attachingImage: "Saving the image…",
  imageFailed: (message: string) => `Could not attach the image: ${message}`,
  attachmentsHint: `Pasted images are saved in .${APP_SLUG}/attachments/. Add .${APP_SLUG}/ to your .gitignore so they are not committed.`,
  gotIt: "Got it",
  sendFailed: (message: string) => `Could not send: ${message}`,
  savedPrompts: "Saved prompts",
  savePrompt: "Save message as prompt",
  promptSaved: (title: string) => `Saved prompt “${title}”`,
  promptsEmpty: "No saved prompts yet. Write a message and save it here to reuse it.",
  filterPrompts: "Filter prompts",
  deletePrompt: (title: string) => `Delete “${title}”`,
  split: {
    splitRight: "Split right",
    closeSplit: "Close split",
    closeHalf: (title: string) => `Close the split (keep “${title}” as a tab)`,
    dropRight: "Drop here to open on the right",
  },
};
