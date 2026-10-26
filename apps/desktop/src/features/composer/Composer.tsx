/**
 * Per-pane composer (DESIGN_SYSTEM §7.6, M4): `❯` · a growing message field with `@` file
 * suggestions · attachment chips · saved prompts · mic · send. Send = one bracketed paste of
 * the message into the pane's PTY, then Enter. Every key handler is on the composer's own
 * elements, so the terminal keeps all of its keys; the composer never takes focus by itself.
 * Dictated text arrives as `dictation:composer` for this pane – never through the OS.
 */
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useStrings } from "../../app/i18n";
import {
  clipboardSaveImage,
  dictationStartComposer,
  dictationStopComposer,
  fsCreateDir,
  fsQuickOpen,
  isAppError,
  onDictationComposer,
  ptyWrite,
  toAppError,
  type QuickOpenItem,
  type SavedPrompt,
} from "../../lib/ipc";
import { useSettingsStore } from "../../stores/settingsStore";
import { useToastStore } from "../../stores/toastStore";
import { PasteWarningModal } from "../terminal/PasteWarningModal";
import { shouldWarnMultilinePaste } from "../terminal/pasteWarning";
import { bracketedPasteMode, focusTerminal } from "../terminal/terminalRegistry";
import { useComposerInbox } from "./composerInbox";
import {
  APP_WORKSPACE_DIR,
  ATTACHMENTS_DIR,
  addSavedPrompt,
  applyMention,
  composeMessage,
  composerKeyAction,
  filterSavedPrompts,
  findMentionQuery,
  hasImage,
  insertText,
  moveIndex,
  pastePayload,
  removeSavedPrompt,
  SUGGESTION_LIMIT,
  type MentionQuery,
} from "./composerLogic";

/** Pause between the paste and Enter, so TUIs that time paste bursts see Enter on its own. */
const ENTER_DELAY_MS = 40;
const SUGGEST_DEBOUNCE_MS = 80;
const MAX_INPUT_HEIGHT = 160;
const NOTICE_MS = 6000;

type DictationState = "idle" | "recording" | "transcribing";

export interface ComposerProps {
  workspaceId: string;
  tabId: string;
  paneId: string;
  agentName: string;
}

const EMPTY_PROMPTS: SavedPrompt[] = [];

function newPromptId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureDir(workspaceId: string, dirRel: string, name: string): Promise<void> {
  try {
    await fsCreateDir(workspaceId, dirRel, name);
  } catch (e) {
    if (!isAppError(e, "already_exists")) throw e;
  }
}

function MicIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function BookmarkIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3h12v18l-6-4-6 4z" />
    </svg>
  );
}

export function Composer({ workspaceId, tabId, paneId, agentName }: ComposerProps) {
  const s = useStrings();
  const c = s.composer;
  const savedPrompts = useSettingsStore((st) => st.settings.composer?.savedPrompts ?? EMPTY_PROMPTS);
  const hintShown = useSettingsStore((st) => st.settings.composer?.attachmentsHintShown ?? false);

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [suggestions, setSuggestions] = useState<QuickOpenItem[]>([]);
  const [selected, setSelected] = useState(0);
  const [dictation, setDictation] = useState<DictationState>("idle");
  const [attaching, setAttaching] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [promptFilter, setPromptFilter] = useState("");
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<number | null>(null);
  const dictationRef = useRef<DictationState>("idle");
  dictationRef.current = dictation;

  const suggestionsOpen = mention !== null && (suggestions.length > 0 || mention.query !== "");
  const message = composeMessage(text, attachments);

  // Grow with the text up to MAX_INPUT_HEIGHT; restore the caret after programmatic edits.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
    if (caretRef.current !== null) {
      el.setSelectionRange(caretRef.current, caretRef.current);
      caretRef.current = null;
    }
  }, [text]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // `@` suggestions from the workspace's quick-open index.
  useEffect(() => {
    if (!mention || mention.query === "") {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fsQuickOpen(workspaceId, mention.query, SUGGESTION_LIMIT)
        .then((result) => {
          if (cancelled) return;
          setSuggestions(result.items);
          setSelected(0);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [workspaceId, mention]);

  // D-066: text handed over from elsewhere (review notes) lands in the field, after what is
  // already there; the user sends it.
  useEffect(() => {
    const takeInbox = () => {
      const handed = useComposerInbox.getState().take(paneId);
      if (handed === null) return;
      setText((current) => {
        const next = current.trim() === "" ? handed : `${current.replace(/\s+$/, "")}\n\n${handed}`;
        caretRef.current = next.length;
        return next;
      });
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    takeInbox();
    return useComposerInbox.subscribe((state) => {
      if (state.pending[paneId] !== undefined) takeInbox();
    });
  }, [paneId]);

  // Composer dictation results for this pane only.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onDictationComposer((result) => {
      if (result.paneId !== paneId) return;
      setDictation("idle");
      if ("text" in result) {
        const el = inputRef.current;
        setText((current) => {
          const start = el?.selectionStart ?? current.length;
          const end = el?.selectionEnd ?? current.length;
          const next = insertText(current, start, end, result.text);
          caretRef.current = next.caret;
          return next.text;
        });
        el?.focus();
      } else if (result.error !== "cancelled") {
        const label = s.dictation.overlay.messages[result.error] ?? s.dictation.overlay.messages.failed;
        setNotice(result.detail ? s.dictation.overlay.withDetail(label, result.detail) : label);
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [paneId, s]);

  // A recording must not outlive its composer (pane closed while dictating).
  useEffect(
    () => () => {
      if (dictationRef.current === "recording") void dictationStopComposer().catch(() => {});
    },
    [],
  );

  // Saved prompts popover: closes on an outside click.
  useEffect(() => {
    if (!promptsOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setPromptsOpen(false);
    };
    window.addEventListener("mousedown", onPointer, true);
    return () => window.removeEventListener("mousedown", onPointer, true);
  }, [promptsOpen]);

  function updateText(value: string, caret: number) {
    setText(value);
    setMention(findMentionQuery(value, caret));
  }

  function accept(item: QuickOpenItem | undefined) {
    if (!item || !mention) return;
    const next = applyMention(text, mention, item.rel);
    caretRef.current = next.caret;
    setText(next.text);
    setMention(null);
    setSuggestions([]);
  }

  async function deliver(body: string, bracketed: boolean) {
    try {
      await ptyWrite(paneId, pastePayload(body, bracketed));
      await new Promise((resolve) => setTimeout(resolve, ENTER_DELAY_MS));
      await ptyWrite(paneId, "\r");
      setText("");
      setAttachments([]);
      setMention(null);
    } catch (e) {
      setNotice(c.sendFailed(toAppError(e).message));
    }
  }

  function send() {
    if (!message) return;
    const bracketed = bracketedPasteMode(tabId);
    // Without bracketed paste every line would be submitted on its own: same guard as a paste.
    const warn = useSettingsStore.getState().settings.terminal.warnMultilinePaste;
    if (shouldWarnMultilinePaste(message, bracketed, warn)) {
      setPendingConfirm(message);
      return;
    }
    void deliver(message, bracketed);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const action = composerKeyAction(e.nativeEvent, suggestionsOpen);
    switch (action) {
      case "send":
        e.preventDefault();
        send();
        return;
      case "next":
      case "previous":
        e.preventDefault();
        setSelected((i) => moveIndex(i, suggestions.length, action === "next" ? 1 : -1));
        return;
      case "accept":
        if (suggestions.length === 0) return;
        e.preventDefault();
        accept(suggestions[selected]);
        return;
      case "close":
        e.preventDefault();
        setMention(null);
        return;
      case "leave":
        e.preventDefault();
        if (promptsOpen) setPromptsOpen(false);
        else focusTerminal(tabId);
        return;
      default:
    }
  }

  async function attachImage() {
    setAttaching(true);
    try {
      await ensureDir(workspaceId, "", APP_WORKSPACE_DIR);
      await ensureDir(workspaceId, APP_WORKSPACE_DIR, "attachments");
      const rel = await clipboardSaveImage(workspaceId, ATTACHMENTS_DIR);
      setAttachments((list) => (list.includes(rel) ? list : [...list, rel]));
      if (!hintShown) setShowHint(true);
    } catch (e) {
      setNotice(c.imageFailed(toAppError(e).message));
    } finally {
      setAttaching(false);
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (!hasImage(e.clipboardData.items)) return;
    e.preventDefault();
    void attachImage();
  }

  function toggleDictation() {
    if (dictation === "recording") {
      setDictation("transcribing");
      void dictationStopComposer().catch(() => setDictation("idle"));
      return;
    }
    if (dictation !== "idle") return;
    setDictation("recording");
    void dictationStartComposer(paneId).catch((e) => {
      setDictation("idle");
      setNotice(toAppError(e).message);
    });
  }

  function dismissHint() {
    setShowHint(false);
    useSettingsStore.getState().update({ composer: { attachmentsHintShown: true } });
  }

  function savePrompt() {
    const body = text.trim();
    if (!body) return;
    const list = addSavedPrompt(savedPrompts, body, newPromptId());
    useSettingsStore.getState().update({ composer: { savedPrompts: list } });
    useToastStore.getState().show(c.promptSaved(list[0]!.title));
  }

  function deletePrompt(id: string) {
    useSettingsStore.getState().update({ composer: { savedPrompts: removeSavedPrompt(savedPrompts, id) } });
  }

  function applyPrompt(prompt: SavedPrompt) {
    const el = inputRef.current;
    const next = insertText(text, el?.selectionStart ?? text.length, el?.selectionEnd ?? text.length, prompt.text);
    caretRef.current = next.caret;
    setText(next.text);
    setPromptsOpen(false);
    el?.focus();
  }

  const visiblePrompts = filterSavedPrompts(savedPrompts, promptFilter);
  const micLabel = dictation === "recording" ? c.stopDictation : dictation === "transcribing" ? c.transcribing : c.dictate;
  const iconButton = "flex h-9 w-9 shrink-0 items-center justify-center rounded-button border border-border bg-surface-5 text-text-2 hover:text-text disabled:opacity-50";

  return (
    <div ref={rootRef} className="relative shrink-0 px-2 pb-2 pt-1.5" data-testid="composer">
      {(notice || showHint) && (
        <div className="mb-1.5 flex flex-col gap-1 text-meta">
          {notice && (
            <div role="alert" className="text-blocked-ink">
              {notice}
            </div>
          )}
          {showHint && (
            <div className="flex items-start gap-2 rounded-control border border-border bg-surface-3 px-2.5 py-1.5 text-text-3">
              <span className="flex-1">{c.attachmentsHint}</span>
              <button type="button" className="shrink-0 font-semibold text-accent" onClick={dismissHint}>
                {c.gotIt}
              </button>
            </div>
          )}
        </div>
      )}

      {suggestionsOpen && (
        <div
          role="listbox"
          aria-label={c.files}
          className="absolute bottom-full left-2 z-30 mb-1 max-h-64 w-[min(520px,calc(100%-16px))] overflow-y-auto rounded-card border border-border bg-surface-2 py-1 shadow-float"
        >
          <div className="px-3 py-1 text-label font-semibold uppercase tracking-[0.08em] text-faint">{c.files}</div>
          {suggestions.length === 0 && <div className="px-3 py-1.5 text-body text-muted">{c.noMatches}</div>}
          {suggestions.map((item, i) => (
            <div
              key={item.rel}
              role="option"
              aria-selected={i === selected}
              className={`cursor-pointer truncate px-3 py-1.5 font-mono text-small ${i === selected ? "bg-accent-soft text-text" : "text-text-2"}`}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the caret in the textarea
                accept(item);
              }}
              onMouseEnter={() => setSelected(i)}
            >
              {item.rel}
            </div>
          ))}
        </div>
      )}

      {promptsOpen && (
        <div
          role="dialog"
          aria-label={c.savedPrompts}
          className="absolute bottom-full right-2 z-30 mb-1 flex max-h-80 w-[min(380px,calc(100%-16px))] flex-col rounded-card border border-border bg-surface-2 shadow-float"
        >
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
            <span className="text-label font-semibold uppercase tracking-[0.08em] text-faint">{c.savedPrompts}</span>
            <div className="flex-1" />
            <button type="button" className="text-small font-semibold text-accent disabled:opacity-50" disabled={!text.trim()} onClick={savePrompt}>
              {c.savePrompt}
            </button>
          </div>
          {savedPrompts.length > 0 && (
            <input
              aria-label={c.filterPrompts}
              placeholder={c.filterPrompts}
              value={promptFilter}
              onChange={(e) => setPromptFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setPromptsOpen(false);
                  inputRef.current?.focus();
                }
              }}
              className="mx-3 mt-2 rounded-control border border-border bg-surface-3 px-2 py-1 text-body text-text outline-none focus:border-accent"
            />
          )}
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {savedPrompts.length === 0 && <div className="px-3 py-2 text-body text-muted">{c.promptsEmpty}</div>}
            {visiblePrompts.map((p) => (
              <div key={p.id} className="group flex items-start gap-2 px-3 py-1.5 hover:bg-surface-4">
                <button type="button" className="flex min-w-0 flex-1 flex-col text-left" onClick={() => applyPrompt(p)}>
                  <span className="truncate text-body font-semibold text-text">{p.title}</span>
                  <span className="truncate text-meta text-muted">{p.text}</span>
                </button>
                <button
                  type="button"
                  aria-label={c.deletePrompt(p.title)}
                  title={c.deletePrompt(p.title)}
                  className="shrink-0 px-1 text-muted hover:text-text"
                  onClick={() => deletePrompt(p.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div
        role="group"
        aria-label={c.region(agentName)}
        className="flex flex-wrap items-end justify-end gap-2.5 rounded-panel border border-border bg-surface-3 py-2 pl-3.5 pr-2 focus-within:border-accent"
      >
        <span aria-hidden className="flex h-9 items-center font-mono font-semibold text-accent">
          ❯
        </span>
        <div className="flex min-w-[140px] flex-1 flex-col justify-center gap-1 self-center py-1">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((rel) => (
                <span key={rel} className="flex items-center gap-1 rounded-control bg-surface-5 px-2 py-[3px] font-mono text-meta text-text-3">
                  @{rel.split("/").pop()}
                  <button type="button" aria-label={c.removeAttachment(rel)} title={rel} className="text-muted hover:text-text" onClick={() => setAttachments((l) => l.filter((r) => r !== rel))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            aria-label={c.region(agentName)}
            placeholder={attaching ? c.attachingImage : c.placeholder}
            title={c.hint}
            spellCheck={false}
            className="block max-h-40 min-h-[22px] w-full resize-none bg-transparent text-ui leading-[22px] text-text outline-none placeholder:text-faint focus-visible:outline-none"
            onChange={(e) => updateText(e.target.value, e.target.selectionStart)}
            onSelect={(e) => setMention(findMentionQuery(e.currentTarget.value, e.currentTarget.selectionStart))}
            onBlur={() => setMention(null)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>
        <button
          type="button"
          aria-label={c.savedPrompts}
          title={c.savedPrompts}
          aria-expanded={promptsOpen}
          className={iconButton}
          onClick={() => {
            setPromptFilter("");
            setPromptsOpen((o) => !o);
          }}
        >
          <BookmarkIcon />
        </button>
        <button
          type="button"
          aria-label={micLabel}
          title={micLabel}
          aria-pressed={dictation === "recording"}
          disabled={dictation === "transcribing"}
          className={`${iconButton} ${dictation === "recording" ? "border-blocked bg-blocked-bg text-blocked-ink pulse-halo [--halo-scale:1.5]" : ""}`}
          onClick={toggleDictation}
        >
          <MicIcon />
        </button>
        <button
          type="button"
          aria-label={c.send}
          title={c.send}
          disabled={!message}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-button bg-accent text-on-accent disabled:opacity-40"
          onClick={send}
        >
          <SendIcon />
        </button>
      </div>

      {pendingConfirm !== null && (
        <PasteWarningModal
          lines={pendingConfirm.split(/\r\n|\r|\n/).length}
          onCancel={() => {
            setPendingConfirm(null);
            inputRef.current?.focus();
          }}
          onConfirm={(dontAskAgain) => {
            if (dontAskAgain) useSettingsStore.getState().update({ terminal: { warnMultilinePaste: false } });
            const body = pendingConfirm;
            setPendingConfirm(null);
            void deliver(body, false);
          }}
        />
      )}
    </div>
  );
}
