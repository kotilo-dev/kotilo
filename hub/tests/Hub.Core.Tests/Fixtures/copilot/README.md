Synthetic GitHub Copilot CLI fixtures, built from the hooks reference (docs.github.com, CLI hooks reference) and the
session event typings shipped with Copilot CLI 1.0.91 (`copilot-sdk/generated/session-events.d.ts`). Not captured from a
real session; ids, paths and numbers are made up. Envelopes are what `agenthub-hook --agent copilot --event <name>` sends
after scrubbing (prompt text already replaced by `prompt_length`).
