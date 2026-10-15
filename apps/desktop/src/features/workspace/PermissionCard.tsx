/**
 * DESIGN_SYSTEM §7.5 permission card: floats over the bottom of the agent's terminal while
 * its agent waits for permission (hub request or a prompt found on screen). Buttons send the
 * agent's own prompt keys (D-016, from its adapter definition) with `pane_send_keys`;
 * "Answer in terminal" hides the card for this request. Enter/Esc act only while focus is
 * inside the card — the terminal keeps its own Esc.
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { useStrings } from "../../app/i18n";
import type { PendingPermission } from "../../lib/hubTypes";
import type { PermissionKeys } from "../agents/permissionKeys";
import { shortAlwaysLabel } from "../agents/promptOptions";

/** Enter/Space/Esc right after the card took focus were typed before it appeared. */
const FOCUS_GRACE_MS = 400;

export type PermissionDecision ="allow" | "always" | "deny";

export interface PermissionCardProps {
  agentName: string;
  projectName: string;
  /** Already formatted, e.g. "1m 12s". */
  waiting: string;
  permission: PendingPermission;
  /** Null when the agent's prompt keys aren't verified: only "Answer in terminal" is offered. */
  keys: PermissionKeys | null;
  /** Move focus to the primary button on open (the pane is visible and the window focused). */
  autoFocus: boolean;
  onDecide: (decision: PermissionDecision, keyName: string) => void;
  onAnswerInTerminal: () => void;
}

function ShieldIcon() {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" />
      <path d="M12 9v4M12 16h.01" />
    </svg>
  );
}

export function PermissionCard(p: PermissionCardProps) {
  const s = useStrings();
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const linkRef = useRef<HTMLButtonElement>(null);
  const focusedAt = useRef(0);

  // On open, and again whenever the pane becomes visible with the window focused (the request
  // may arrive while the user is elsewhere). Focus is taken only from this pane's terminal, an
  // empty input or nothing, so text being typed somewhere else is never redirected.
  useEffect(() => {
    if (!p.autoFocus) return;
    const card = cardRef.current;
    const active = document.activeElement;
    if (!card || (active && card.contains(active))) return;
    const pane = card.closest("[data-agent-pane]");
    const free =
      !active ||
      active === document.body ||
      (pane?.contains(active) === true && !((active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && active.value !== ""));
    if (!free) return;
    (primaryRef.current ?? linkRef.current)?.focus();
    focusedAt.current = Date.now();
  }, [p.autoFocus]);

  const tool = p.permission.tool ?? "";
  const title = p.permission.command
    ? s.permission.runCommand(p.agentName)
    : p.permission.path
      ? s.permission.editFile(p.agentName)
      : tool
        ? s.permission.useTool(p.agentName, tool)
        : s.permission.needsPermission(p.agentName);
  const risk = p.permission.risk && p.permission.risk !== "other" ? s.permission.risk[p.permission.risk] : null;
  const subject = p.permission.command ?? p.permission.path;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // A key already on its way to the terminal or composer must not land on the button that
    // just took focus.
    const onFocusedButton = e.target === primaryRef.current || e.target === linkRef.current;
    if (onFocusedButton && ["Enter", " ", "Escape"].includes(e.key) && Date.now() - focusedAt.current < FOCUS_GRACE_MS) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "Escape" && p.keys) {
      e.preventDefault();
      e.stopPropagation();
      p.onDecide("deny", p.keys.deny);
      return;
    }
    // Enter on a button activates that button natively; elsewhere in the card it allows once.
    const onControl = e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement;
    if (e.key === "Enter" && p.keys && !onControl) {
      e.preventDefault();
      e.stopPropagation();
      p.onDecide("allow", p.keys.allowOnce);
    }
  }

  return (
    <div
      ref={cardRef}
      role="region"
      aria-label={s.permission.region}
      aria-live="assertive"
      onKeyDown={onKeyDown}
      className="absolute bottom-[22px] left-[22px] right-[22px] z-10 max-h-[calc(100%-44px)] overflow-y-auto animate-rise rounded-[14px] border border-blocked/45 bg-surface-4 px-[18px] pb-4 pt-[18px] shadow-float"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-blocked-bg text-blocked-ink">
          <ShieldIcon />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="text-[14.5px] font-semibold text-text">{title}</span>
          <span className="text-small text-muted">{s.permission.waiting(p.projectName, p.waiting)}</span>
        </div>
        <div className="flex-1" />
        {risk && <span className="rounded-badge bg-blocked-bg px-[9px] py-[3px] text-meta text-blocked-ink">{risk}</span>}
      </div>
      {subject && (
        <div className="mt-3.5 overflow-x-auto whitespace-pre-wrap break-all rounded-[10px] border border-border-subtle bg-terminal px-3.5 py-3 font-mono text-ui text-text">
          {p.permission.command && <span className="text-faint">$ </span>}
          {subject}
        </div>
      )}
      {!subject && !tool && <p className="m-0 mt-3 text-body text-text-2">{s.permission.readPromptInTerminal}</p>}
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        {p.keys && (
          <>
            <button
              ref={primaryRef}
              type="button"
              onClick={() => p.onDecide("allow", p.keys!.allowOnce)}
              className="flex h-[38px] items-center gap-2 rounded-button bg-text px-4 text-ui font-semibold text-bg"
            >
              {s.permission.allowOnce}
              <span className="font-mono text-label opacity-60">{s.permission.keyEnter}</span>
            </button>
            {p.keys.alwaysAllow && (
              <button
                type="button"
                title={p.keys.alwaysLabel}
                onClick={() => p.onDecide("always", p.keys!.alwaysAllow!)}
                className="h-[38px] max-w-full truncate rounded-button border border-border bg-surface-5 px-4 text-ui font-medium text-text"
              >
                {p.keys.alwaysLabel ? shortAlwaysLabel(p.keys.alwaysLabel) : s.permission.alwaysAllow}
              </button>
            )}
            <button
              type="button"
              onClick={() => p.onDecide("deny", p.keys!.deny)}
              className="flex h-[38px] items-center gap-2 rounded-button border border-blocked/35 bg-transparent px-4 text-ui font-medium text-blocked-ink"
            >
              {s.permission.deny}
              <span className="font-mono text-label opacity-60">{s.permission.keyEsc}</span>
            </button>
          </>
        )}
        <div className="flex-1" />
        <button ref={linkRef} type="button" onClick={p.onAnswerInTerminal} className="text-body text-accent underline-offset-2 hover:underline">
          {s.permission.answerInTerminal}
        </button>
      </div>
    </div>
  );
}

/**
 * The note shown briefly after a decision: which key went to the agent. A small pill in the
 * top-right corner, not over the bottom rows where the agent redraws its prompt, and it never
 * takes clicks.
 */
export function PermissionResult({ decision, keyName }: { decision: PermissionDecision; keyName: string }) {
  const s = useStrings();
  const text =
    decision === "allow"
      ? s.permission.resultAllow(keyName)
      : decision === "always"
        ? s.permission.resultAlways(keyName)
        : s.permission.resultDeny(keyName);
  const tone = decision === "deny" ? "border-done/35 bg-done-bg text-done-ink" : "border-idle/35 bg-idle-bg text-idle-ink";
  return (
    <div
      role="status"
      className={`pointer-events-none absolute right-3 top-3 z-10 flex max-w-[calc(100%-24px)] animate-rise items-center gap-2 rounded-card border px-3 py-1.5 text-small shadow-float ${tone}`}
    >
      <svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12l5 5 9-10" />
      </svg>
      <span>{text}</span>
    </div>
  );
}
