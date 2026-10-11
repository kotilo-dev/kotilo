/**
 * M7: the assistant chat popup and its settings. Part of `en` as `assistant`;
 * `assistant.tr.ts` has the same shape.
 */
import { APP_NAME } from "../constants";

export const assistantEn = {
  // Popup header
  title: "Assistant",
  providerModel: (provider: string, model: string | null) => (model ? `${provider} · ${model}` : provider),
  newChat: "New chat",
  close: "Close",
  // Messages
  emptyTitle: "Ask anything",
  emptyHint: "A small general-purpose chat for quick questions. It doesn't see your sessions, files or usage.",
  messagesLabel: "Conversation",
  you: "You",
  answer: "Answer",
  typing: "Writing…",
  stopped: "Stopped.",
  copyAnswer: "Copy answer",
  copyCode: "Copy code",
  copied: "Copied",
  // Composer
  composerLabel: "Message",
  composerPlaceholder: "Ask a question…",
  send: "Send",
  stop: "Stop",
  stopping: "Stopping…",
  keysHint: "Enter to send · Shift+Enter for a new line · ↑ edits the last question · Esc closes",
  // Errors and empty state
  openSettings: "Settings → AI",
  loading: "Loading…",
  offTitle: "The assistant is off",
  offText: "Turn it on in Settings → AI.",
  unavailableTitle: "The assistant isn't available",
  unavailableText: "The AI provider picked for the assistant can't be used right now.",
  errors: {
    notInstalled: "The agent CLI picked for the assistant isn't installed.",
    notLoggedIn: "The agent CLI isn't signed in. Sign in to it in a terminal first.",
    notConfigured: "The provider isn't set up yet (no model?).",
    unreachable: "Can't reach the AI endpoint.",
    unauthorized: "The AI endpoint rejected the API key.",
    timeout: "The answer took too long and was stopped.",
    failed: "The provider gave no usable answer.",
    cancelled: "The answer was cancelled.",
    busy: "Another answer is still running. Try again in a moment.",
    disabled: "The assistant is off.",
    hubUnavailable: `${APP_NAME}'s background service isn't running.`,
    invalid: "The request was rejected.",
  },
  errorGeneric: (detail: string) => `Something went wrong: ${detail}`,
  errorGenericNoDetail: "Something went wrong.",
  // Footer
  nothingSaved: "Nothing is saved",
  toolsOff: "tools off",
  sentTo: (provider: string) => `sent to ${provider}`,
  keepsCopy: (provider: string) => `${provider} keeps its own copy of this chat in its session files.`,
  mayKeepCopy: (provider: string) => `${provider} may keep its own copy of this chat.`,
  // Settings → AI (assistant row) and the mascot menu
  settings: {
    enabled: "Turn on the assistant",
    enabledHint: "Opens with a shortcut from any app. Nothing is saved: every opening starts a new chat.",
    hotkey: "Shortcut",
    hotkeyHint: "Opens and closes the assistant, e.g. Ctrl+Alt+Space.",
    hotkeyTaken: "Shortcut is used by another app. Pick a different one.",
    hotkeyInvalid: "This isn't a valid shortcut. Use modifiers and a key, e.g. Ctrl+Alt+Space.",
    open: "Open assistant",
  },
  openFromMascot: "Open assistant",
};
