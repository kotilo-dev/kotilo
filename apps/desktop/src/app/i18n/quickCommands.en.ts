/**
 * D-069: quick commands (saved shell commands and agent prompts). Part of `en` as
 * `quickCommands`; `quickCommands.tr.ts` has the same shape.
 */
export const quickCommandsEn = {
  button: "Quick commands",
  commandsGroup: "Commands",
  promptsGroup: "Prompts",
  manage: "Manage quick commands…",
  empty: "No quick commands yet.",
  noAgent: "No agent is running in this workspace to take the prompt.",
  // Settings → Quick commands
  intro:
    "Shell commands are typed into the current terminal (or a new tab when an agent runs there). Prompts go into an agent's message field, and you send them. Prompts saved from the message field show up here too.",
  add: "Add",
  edit: "Edit",
  delete: "Delete",
  save: "Save",
  cancel: "Cancel",
  kind: "Type",
  kindCommand: "Shell command",
  kindPrompt: "Agent prompt",
  title: "Name",
  titlePlaceholder: "Shown in the menu and the command palette",
  command: "Command",
  commandPlaceholder: "npm test",
  prompt: "Prompt",
  promptPlaceholder: "Review the uncommitted changes and list risky spots.",
  scope: "Available in",
  scopeAll: "All workspaces",
  scopeMissing: (path: string) => `${path} (not open)`,
  listLabel: "Quick commands",
  textRequired: "Enter the command or prompt text.",
};
