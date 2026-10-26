# Keybindings

All shortcuts use `Ctrl` (not `Cmd` — this is a Windows-only app). Combinations are
written in the normalized form Kotilo itself uses internally, e.g. `` Ctrl+` ``.

## Scope model

Every shortcut below falls into one of three buckets:

- **Global** — works everywhere, including while a terminal is focused. The key is
  swallowed before it reaches the shell.
- **Not-terminal** — works everywhere *except* while a terminal is focused; with a
  terminal focused, the key passes straight through to the shell/program running in
  it instead.
- **Terminal-local** — only meaningful (and only handled) while a terminal is
  focused; it never reaches the app's command registry.

This matters most for `Ctrl+P`: with a terminal focused, `Ctrl+P` is sent to the
shell/program instead of opening quick open — this is deliberate, so that
an agent CLI's own `Ctrl+P` binding (and a shell's own history-search binding)
keeps working. `Ctrl+Shift+P` (the command palette) and `Ctrl+,` (Settings), by
contrast, are **global** and always open, even with a terminal focused.

## Global

| Shortcut | Action |
|---|---|
| `Ctrl+B` | Toggle the left column (Workspaces/Agents) |
| `Ctrl+J` | Toggle the Terminal column |
| `Ctrl+Shift+U` | Toggle the Viewer column |
| `` Ctrl+` `` | Focus the active workspace's terminal (creates one if none exists) |
| `Ctrl+1` … `Ctrl+9` | Switch to the Nth workspace |
| `Alt+1` … `Alt+9` | Go to Workspace, Overview, Mission control, Usage, Reports, Projects, Tasks, Sessions, Dictation (nav rail order) — global, works from a terminal too |
| `Ctrl+Shift+A` | Jump to the next blocked agent (after the currently focused pane, wrapping around) |
| `Ctrl+Tab` | Next viewer tab (active workspace) |
| `Ctrl+Shift+Tab` | Previous viewer tab (active workspace) |
| `Ctrl+Shift+P` | Open the command palette |
| `Ctrl+,` | Go to the Settings screen |
| `F1` | Open Help (on the last-viewed doc) — global, works from a terminal too; WebView2 has no default F1 binding of its own |

## System-wide (dictation)

These work in every program while Kotilo runs; change them in Settings → Dictation.

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+D` | Dictate: hold to talk, or tap to start and tap again to finish |
| `Esc` | Cancel the dictation in progress (only while dictating) |
| `Ctrl+Alt+Shift+D` | Paste the last dictation again |

## Command palette / quick open

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+P` | Open in command mode (or switch an already-open quick open to command mode) |
| `Ctrl+P` | Open in file mode (not-terminal scope — see [Scope model](#scope-model)); switches an already-open command-mode dialog to file mode |
| `>` (typed as the first character) | Switches file mode to command mode |
| deleting a leading `>` | Switches command mode back to file mode |
| `↑` / `↓` | Move selection |
| `PageUp` / `PageDown` | Move selection by a page |
| `Enter` | Open the selected file in a preview tab / run the selected command |
| `Ctrl+Enter` | Open the selected file in a new pinned tab |
| `Esc` | Close |

## File tree

Active only while the tree itself has keyboard focus (not while an inline rename/
create box, a context menu, or a confirmation dialog is open — those consume the
keys themselves).

| Shortcut | Action |
|---|---|
| `↑` / `↓` | Move selection |
| `←` | Collapse the selected folder, or select its parent if already collapsed |
| `→` | Expand the selected folder (or the active workspace root) |
| `Enter` | Open the selected file in a preview tab (same as double-click); open/close a folder or activate a workspace root |
| `Ctrl+Enter` | Open the selected file in a new pinned tab |
| `F2` | Rename the selected item |
| `Delete` | Delete the selected item (with confirmation) |
| `Ctrl+V` | Save the clipboard image into the selected folder (only when a folder or a workspace root is selected — see [user guide](user-guide.md#workspaces)) |
| `Esc` (in the filter box) | Clear the filter |

Inline rename/create boxes: `Enter` submits, `Esc` cancels.

## Viewer / editor

| Shortcut | Scope | Action |
|---|---|---|
| `Ctrl+S` | Not-terminal | Save the active tab |
| `Ctrl+W` | Not-terminal | Close the active tab (asks to save if dirty) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Global | Next/previous tab in the active workspace |
| `Ctrl+Shift+M` | Not-terminal | Toggle Markdown Edit ↔ Preview for the active tab |
| `Shift+Alt+F` | Editor-local (Monaco) | Format the document (JSON: Monaco's built-in formatter; XML: Kotilo's XML formatter) |
| `Ctrl+F` | PDF viewer only | Open in-document search |
| `Esc` | PDF search box | Close search |

Monaco's own default shortcuts (its built-in find/replace, multi-cursor, code
folding, etc.) work as usual inside the text editor — only `Ctrl+S`/`Ctrl+W`/
`Ctrl+Tab`/`Ctrl+Shift+Tab`/`Ctrl+Shift+M`/`Shift+Alt+F` above are Kotilo's own
additions layered on top.

## Terminal

These only apply while a terminal is focused.

| Shortcut | Action |
|---|---|
| `Ctrl+C` | Copy the current selection (and clear it) if there is one; otherwise sends SIGINT (interrupt) to the shell |
| `Ctrl+V` | Paste clipboard text; if the clipboard has no text (e.g. an image), sends `^V` to the shell instead (so claude's own image-paste shortcut still works) |
| `Ctrl+Shift+C` | Always copy the current selection (kept, not cleared) |
| `Ctrl+Shift+V` | Always paste clipboard text only |
| `Ctrl+Shift+F` | Open in-terminal search |
| `Shift+Insert` | Paste (goes through the same multi-line paste warning as `Ctrl+V`) |
| Right-click | Copy the selection if there is one, otherwise paste |
| `Enter` (in the search box) | Find next match (`Shift+Enter` finds previous) |
| `Esc` (in the search box) | Close search |

The following are handled by Kotilo (not sent to the shell) even while a terminal
is focused — see [Scope model](#scope-model):
`Ctrl+B`, `Ctrl+J`, `Ctrl+Shift+U`, `` Ctrl+` ``, `Ctrl+Shift+A`, `Ctrl+1`–`Ctrl+9`, `Alt+1`–`Alt+9`,
`Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+Shift+P`, `Ctrl+,`, `F1`.

Everything else — including `Ctrl+P`, `Ctrl+S`, `Ctrl+W`, `Ctrl+Shift+M`, and any key
not listed above — passes straight through to the shell/program running in the
terminal.

## Agents

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+A` | Jump to the next blocked agent (global — see above) |
| Click an agent row | Jump to that workspace/tab (turns a `done` row into `idle`) |

### Permission card

Shown over an agent's terminal while it waits for permission (when the background service
knows the request). These keys act only while focus is inside the card — the terminal keeps
its own `Esc`. Focus moves to **Allow once** when the card opens in the visible, focused
window.

| Shortcut | Action |
|---|---|
| `Enter` | **Allow once** (sends the agent's own key: `1` for Claude Code, `y` for Codex); on a focused button, activates that button |
| `Esc` | **Deny** (sends `Esc` to the agent) |
| `Tab` / `Shift+Tab` | Move between Allow once, Always allow in this project, Deny and Answer in terminal |

**Answer in terminal** hides the card for that request and focuses the terminal, so you can
answer the agent's own prompt there.

### Composer

The message field below an agent's terminal (see [user guide](user-guide.md#composer)).
These keys act only while focus is in the composer; it never takes focus by itself.

| Shortcut | Action |
|---|---|
| `Enter` | Send the message to the agent (pasted into its terminal, then `Enter`) |
| `Shift+Enter` | New line in the message |
| `Esc` | Back to the terminal (closes the saved prompts list first, if open) |
| `@` + text | File suggestions: `↑`/`↓` choose, `Enter` or `Tab` insert, `Esc` closes the list |
| `Ctrl+V` with an image on the clipboard | Attach the image (saved in `.kotilo/attachments/`) |

The [Timeline](user-guide.md#timeline) rail has no shortcut yet; use the command
palette's **View: Toggle Timeline**. Splitting the terminal panel has no shortcut either
(see [Split pane](user-guide.md#split-pane)).

## Dialogs

Applies to Help, the command palette/quick open,
context menus, and the confirmation modals (delete, remove workspace, unsaved
changes, multi-line paste warning, busy-terminal close):

| Shortcut | Action |
|---|---|
| `Esc` | Close/cancel (focus returns to whatever was focused before the dialog opened) |
| `Enter` | In a confirmation modal (unsaved changes, delete, remove workspace, busy-terminal close), activates the primary action button, which is focused automatically when the modal opens (e.g. **Save all**). Context menus don't auto-focus an item, so `Enter` only activates one after you've reached it with `Tab`/arrow keys. |
| `Tab` / `Shift+Tab` | Move focus between the dialog's controls (the browser's native tab order) |
| Click outside the dialog | Close/cancel (same as `Esc`) |

The multi-line paste warning additionally binds `Enter` to **Paste** and `Esc` to
**Cancel** explicitly (not just "activates the focused button"), so it works even if
you've just checked the "Don't ask again" box.
