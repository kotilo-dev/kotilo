/**
 * The numbered options of the permission dialog an agent shows at the bottom of its screen
 * (0.3.2). Claude Code's hook data does not list the dialog's options: the same request may show
 * "1. Yes / 2. Yes, and don't ask again … / 3. No" or only "1. Yes / 2. No" (an ask rule in auto
 * mode, subagent prompts), so a fixed "always = 2" key could answer No. The card reads the
 * pane's last rows (`readBufferTail`) and decides its buttons from what is actually on screen.
 */
import type { PermissionKeys } from "./permissionKeys";

export interface PromptOption {
  number: string;
  label: string;
}

/** Box-drawing borders and the cursor marks Ink/TUI dialogs draw around and before options. */
const BORDER = /^[\s│┃║|]+|[\s│┃║|]+$/g;
const OPTION = /^(?:[❯>›▶→▸*]\s*)?(\d{1,2})[.)]\s+(\S.*)$/;
const CURSOR = /^[❯>›▶→▸]/;
const YES = /^(yes|allow|always|approve)\b/i;

interface Row {
  text: string;
  indent: number;
}

function cleanRow(raw: string): Row {
  // Only the left border is cut before measuring the indent: a wrapped label's continuation is
  // indented to the label's column inside the box.
  const inner = raw.replace(/^\s*[│┃║|]/, "").replace(/[│┃║|]\s*$/, "");
  const indent = inner.length - inner.trimStart().length;
  return { text: inner.replace(BORDER, "").trim(), indent };
}

/**
 * The last numbered dialog in `rows` (oldest first): consecutive options 1, 2, … with the
 * selection cursor on one of them (an agent's own numbered list in its answer has no cursor).
 * A row that is indented at least to the previous label's column continues that label (the TUI
 * wraps long labels itself). Empty when there is no such dialog.
 */
export function parsePromptOptions(rows: readonly string[]): PromptOption[] {
  let best: PromptOption[] = [];
  let current: PromptOption[] = [];
  let hasCursor = false;
  let labelColumn = -1;

  const close = () => {
    if (current.length >= 2 && hasCursor) best = current;
    current = [];
    hasCursor = false;
    labelColumn = -1;
  };

  for (const raw of rows) {
    const row = cleanRow(raw);
    const m = OPTION.exec(row.text);
    if (m) {
      const number = m[1]!;
      if (String(current.length + 1) !== number) {
        close();
        if (number !== "1") continue;
      }
      current.push({ number, label: m[2]!.trim() });
      if (CURSOR.test(row.text)) hasCursor = true;
      labelColumn = row.indent + (row.text.length - m[2]!.length);
      continue;
    }
    if (current.length > 0 && row.text !== "" && labelColumn >= 0 && row.indent >= labelColumn) {
      const last = current[current.length - 1]!;
      last.label = `${last.label} ${row.text}`;
      continue;
    }
    close();
  }
  close();
  return best;
}

const MAX_BUTTON_LABEL = 44;

/** "Yes, and don't ask again for npm commands in C:\x (shift+tab)" → "Don't ask again for npm commands…". */
export function shortAlwaysLabel(label: string): string {
  let text = label.replace(/\s*\((?:esc|shift\+tab|tab|[a-z])\)\s*$/i, "").replace(/^yes,\s*(and\s+)?/i, "");
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return text.length > MAX_BUTTON_LABEL ? `${text.slice(0, MAX_BUTTON_LABEL - 1).trimEnd()}…` : text;
}

function isDigitKey(key: string | undefined): boolean {
  return key !== undefined && /^\d{1,2}$/.test(key);
}

/**
 * The card's keys after looking at the screen. `strict`: the agent's options vary per prompt
 * (Claude Code), so without a parsed dialog there is no "always" button. Other agents keep their
 * definition's keys unless the parsed dialog proves there is no second "yes" answer.
 */
export function screenPermissionKeys(keys: PermissionKeys | null, options: readonly PromptOption[], strict: boolean): PermissionKeys | null {
  if (!keys) return null;
  const base: PermissionKeys = { allowOnce: keys.allowOnce, deny: keys.deny };
  if (!keys.alwaysAllow) return base;
  if (options.length === 0) return strict ? base : keys;
  const always = options.find((o) => o.number !== "1" && YES.test(o.label));
  if (!always) return base;
  const alwaysAllow = isDigitKey(keys.alwaysAllow) ? always.number : keys.alwaysAllow;
  return { ...base, alwaysAllow, alwaysLabel: always.label };
}
