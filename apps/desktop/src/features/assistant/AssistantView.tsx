/**
 * The assistant chat popup (M7, D-053): `index.html?view=assistant`, a small focusable window
 * Rust shows with the global shortcut. General chat only – no session or usage context – and
 * no history: the conversation lives in this component's memory and is dropped whenever Rust
 * says the window opened or closed. Nothing goes to storage or the log.
 */
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { useStrings, type Strings } from "../../app/i18n";
import { toAppError } from "../../lib/ipc";
import { AssistantMarkdown, CopyButton } from "./AssistantMarkdown";
import {
  assistantChat,
  assistantHide,
  assistantInfo,
  assistantStop,
  onAssistantClosed,
  onAssistantOpened,
  requestAiSettings,
  type AssistantInfo,
} from "./assistantIpc";
import { errorText, footerVariant, keyAction, needsSettings } from "./assistantLogic";
import { conversationReducer, INITIAL_CONVERSATION, isRunning, lastUserText, messagesFor, runningTurn, type ChatMeta, type Turn } from "./conversation";
import { CloseIcon, NewChatIcon, SendIcon, SettingsIcon, SparkIcon, StopIcon } from "./icons";
import { formatKeybinding } from "../../lib/keys";
import "./assistant.css";

type T = Strings["assistant"];

/** Distance from the bottom (px) that still counts as "at the bottom" for auto-scroll. */
const STICK_PX = 40;
const COMPOSER_MAX_PX = 140;
/** Grace period for Channel frames after `assistant_chat` resolved before a turn without `done` counts as lost. */
const LOST_AFTER_MS = 1_000;

function openSettings(): void {
  void assistantHide().catch(() => {});
  void requestAiSettings().catch(() => {});
}

function IconButton({ label, title, onClick, children }: { label: string; title?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-control text-text-3 transition-colors duration-150 hover:bg-surface-5 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}

function SettingsButton({ t }: { t: T }) {
  return (
    <button
      type="button"
      onClick={openSettings}
      className="inline-flex h-7 items-center gap-1.5 self-start rounded-control border border-border bg-surface-5 px-2.5 text-small text-text-2 transition-colors duration-150 hover:bg-surface-selected hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <SettingsIcon />
      {t.openSettings}
    </button>
  );
}

function TurnView({ turn, t }: { turn: Turn; t: T }) {
  const streaming = turn.status === "streaming";
  return (
    <li className="flex flex-col gap-2" data-testid="assistant-turn" data-status={turn.status}>
      <div className="flex justify-end">
        <div aria-label={t.you} className="max-w-[85%] whitespace-pre-wrap break-words rounded-card rounded-br-badge bg-accent px-3 py-2 text-ui text-on-accent">
          {turn.user}
        </div>
      </div>
      <div aria-label={t.answer} className="flex min-w-0 flex-col gap-1.5" aria-busy={streaming || undefined}>
        {turn.answer !== "" && <AssistantMarkdown text={turn.answer} />}
        {streaming && (
          <span className="assistant-typing inline-flex h-4 items-center" role="status" aria-label={turn.stopping ? t.stopping : t.typing} data-testid="assistant-typing">
            <span />
            <span />
            <span />
          </span>
        )}
        {turn.status === "stopped" && <span className="text-small text-muted">{t.stopped}</span>}
        {turn.status === "error" && (
          <div role="alert" className="flex flex-col gap-2 rounded-control border border-blocked/35 bg-blocked-bg px-3 py-2">
            <span className="text-body text-blocked-ink">{errorText(t, turn.errorKind, turn.error)}</span>
            {needsSettings(turn.errorKind) && <SettingsButton t={t} />}
          </div>
        )}
        {turn.status === "done" && (
          <div className="-ml-1 flex">
            <CopyButton text={turn.answer} label={t.copyAnswer} />
          </div>
        )}
      </div>
    </li>
  );
}

function Footer({ t, meta }: { t: T; meta: ChatMeta | null }) {
  if (!meta) return null;
  const variant = footerVariant(meta.ephemeral);
  return (
    <div className="flex flex-col gap-1 px-4 pb-3 text-meta" data-testid="assistant-footer" data-variant={variant}>
      <span className="text-muted">
        {t.nothingSaved} · {t.toolsOff} · {t.sentTo(meta.providerLabel)}
      </span>
      {variant === "keeps" && <span className="text-working-ink">{t.keepsCopy(meta.providerLabel)}</span>}
      {variant === "mayKeep" && <span className="text-faint">{t.mayKeepCopy(meta.providerLabel)}</span>}
    </div>
  );
}

function reasonText(t: T, reason: string | null, fallback: string): string {
  if (reason && Object.prototype.hasOwnProperty.call(t.errors, reason)) return t.errors[reason as keyof T["errors"]];
  return reason || fallback;
}

export function AssistantView({ onOpened }: { onOpened?: () => void }) {
  const t = useStrings().assistant;
  const [state, dispatch] = useReducer(conversationReducer, INITIAL_CONVERSATION);
  const [info, setInfo] = useState<AssistantInfo | null>(null);
  const [infoFailed, setInfoFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;
  const openedRef = useRef(onOpened);
  openedRef.current = onOpened;

  const running = isRunning(state);
  const meta: ChatMeta | null = state.meta ?? (info ? { providerLabel: info.providerLabel, model: info.model, ephemeral: info.ephemeral } : null);
  const usable = info !== null && info.enabled && info.available;

  const loadInfo = useCallback(async () => {
    try {
      setInfo(await assistantInfo());
      setInfoFailed(false);
    } catch {
      setInfoFailed(true);
    }
  }, []);

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const reset = useCallback(() => {
    if (isRunning(stateRef.current)) void assistantStop().catch(() => {});
    dispatch({ type: "reset" });
    setDraft("");
    stickRef.current = true;
  }, []);

  useEffect(() => {
    void loadInfo();
    focusInput();
    const unlisten = [
      onAssistantOpened(() => {
        reset();
        openedRef.current?.();
        void loadInfo();
        focusInput();
      }),
      onAssistantClosed(reset),
    ];
    return () => {
      for (const p of unlisten) void p.then((u) => u()).catch(() => {});
    };
  }, [loadInfo, focusInput, reset]);

  const send = useCallback(() => {
    const current = stateRef.current;
    const text = draft.trim();
    if (text === "" || isRunning(current) || !usable) return;
    const messages = messagesFor(current, text);
    const turnId = current.nextId;
    dispatch({ type: "send", text });
    setDraft("");
    stickRef.current = true;
    assistantChat(messages, (event) => dispatch({ type: "event", turnId, event })).then(
      () => {
        dispatch({ type: "ended", turnId, lost: false });
        setTimeout(() => dispatch({ type: "ended", turnId, lost: true }), LOST_AFTER_MS);
      },
      (e: unknown) => dispatch({ type: "failed", turnId, error: toAppError(e).message }),
    );
  }, [draft, usable]);

  const stop = useCallback(() => {
    const turn = runningTurn(stateRef.current);
    if (!turn) return;
    dispatch({ type: "stop" });
    // Rust sends nothing more after a stop: the turn ends when the stop is through.
    void assistantStop()
      .catch(() => {})
      .then(() => dispatch({ type: "ended", turnId: turn.id, lost: false }));
  }, []);

  const newChat = useCallback(() => {
    reset();
    focusInput();
  }, [reset, focusInput]);

  const editLast = useCallback(() => {
    const text = lastUserText(stateRef.current);
    if (text === null) return;
    dispatch({ type: "editLast" });
    setDraft(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);

  // Keys work wherever the focus is (Esc, Ctrl+N) or in the composer (Enter, ↑).
  const handlers = useRef({ send, stop, newChat, editLast, draft, running });
  handlers.current = { send, stop, newChat, editLast, draft, running };
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const h = handlers.current;
      const action = keyAction(e, { running: h.running, inComposer: e.target === inputRef.current, composerEmpty: h.draft === "" });
      if (!action) return;
      e.preventDefault();
      if (action === "send") h.send();
      else if (action === "stop") h.stop();
      else if (action === "close") void assistantHide().catch(() => {});
      else if (action === "newChat") h.newChat();
      else h.editLast();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Follow the answer while the user stays at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [state.turns]);

  // Composer grows with its text up to a limit.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, [draft]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden rounded-panel border border-border bg-surface-2 text-text" data-testid="assistant">
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-surface-3 py-2 pl-4 pr-2">
        <span className="text-accent" aria-hidden="true">
          <SparkIcon />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="m-0 text-title font-semibold text-text">
            {t.title}
          </h1>
          {meta && (
            <span className="truncate text-meta text-muted" data-testid="assistant-provider">
              {t.providerModel(meta.providerLabel, meta.model)}
            </span>
          )}
        </div>
        <IconButton label={t.newChat} title={`${t.newChat} (${formatKeybinding("Mod+N")})`} onClick={newChat}>
          <NewChatIcon />
        </IconButton>
        <IconButton label={t.close} title={`${t.close} (Esc)`} onClick={() => void assistantHide().catch(() => {})}>
          <CloseIcon />
        </IconButton>
      </header>

      {info !== null && !usable ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center" data-testid="assistant-unavailable">
          <span className="text-muted" aria-hidden="true">
            <SparkIcon size={28} />
          </span>
          <span className="text-title font-semibold text-text">{info.enabled ? t.unavailableTitle : t.offTitle}</span>
          <span className="text-body text-muted">{info.enabled ? reasonText(t, info.unavailableReason, t.unavailableText) : t.offText}</span>
          <div className="flex justify-center">
            <SettingsButton t={t} />
          </div>
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
            }}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
          >
            {state.turns.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                <span className="text-title font-semibold text-text">{infoFailed ? t.unavailableTitle : t.emptyTitle}</span>
                <span className="text-body text-muted">{infoFailed ? t.errors.hubUnavailable : t.emptyHint}</span>
                <span className="mt-2 text-meta text-faint">{t.keysHint}</span>
              </div>
            ) : (
              <ol aria-label={t.messagesLabel} aria-live="polite" className="m-0 flex list-none flex-col gap-5 p-0">
                {state.turns.map((turn) => (
                  <TurnView key={turn.id} turn={turn} t={t} />
                ))}
              </ol>
            )}
          </div>

          <div className="shrink-0 px-3 pb-2 pt-1">
            <div className="flex items-end gap-2 rounded-card border border-border bg-surface-3 p-1.5 pl-3 focus-within:border-accent">
              <textarea
                ref={inputRef}
                rows={1}
                value={draft}
                aria-label={t.composerLabel}
                placeholder={t.composerPlaceholder}
                title={t.keysHint}
                onChange={(e) => setDraft(e.target.value)}
                className="assistant-composer max-h-[140px] min-h-[30px] flex-1 resize-none bg-transparent py-1.5 text-ui text-text outline-none placeholder:text-muted"
              />
              {running ? (
                <button
                  type="button"
                  onClick={stop}
                  disabled={runningTurn(state)?.stopping}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-button border border-blocked/35 bg-transparent px-2.5 text-small text-blocked-ink transition-colors duration-150 hover:bg-blocked-bg disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <StopIcon />
                  {runningTurn(state)?.stopping ? t.stopping : t.stop}
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={t.send}
                  title={`${t.send} (Enter)`}
                  onClick={send}
                  disabled={draft.trim() === "" || !usable}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-button bg-accent text-on-accent transition-opacity duration-150 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <SendIcon />
                </button>
              )}
            </div>
          </div>
          <Footer t={t} meta={meta} />
        </>
      )}
    </div>
  );
}
