/**
 * D-066: review notes in the diff tab. `ReviewZones` adds notes to the working-copy side of a
 * Monaco diff (a "+" in the glyph margin on hover, the context menu or C on a selection) and
 * shows each note as a view zone under its lines; `SendNotesButton` puts all open notes of the
 * workspace into an agent's composer as one prompt.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type * as Monaco from "monaco-editor/editor/editor.api";
import { useStrings } from "../../app/i18n";
import { agentDisplayName } from "../../app/ui";
import type { Agent } from "../../lib/ipc";
import { useAgentStore } from "../../stores/agentStore";
import { useDefinitionsStore } from "../../stores/definitionsStore";
import { useHubStore } from "../../stores/hubStore";
import { matchSession } from "../workspace/paneSession";
import { useTerminalStore } from "../../stores/terminalStore";
import { useToastStore } from "../../stores/toastStore";
import { navigateToAgent } from "../agents/navigate";
import { useComposerInbox } from "../composer/composerInbox";
import { ContextMenu, type ContextMenuState } from "../workspaces/ContextMenu";
import { buildReviewPrompt, lineLabel, type ReviewNote } from "./reviewNotes";
import { openNotes, useOpenNoteCount, useReviewStore } from "./reviewStore";

type MonacoApi = typeof Monaco;
type Editor = Monaco.editor.IStandaloneCodeEditor;

interface Draft {
  startLine: number;
  endLine: number;
}

/** A selection ending at column 1 of the next line covers the lines above it. */
function selectionLines(sel: Monaco.Selection): Draft {
  const end = sel.endLineNumber > sel.startLineNumber && sel.endColumn === 1 ? sel.endLineNumber - 1 : sel.endLineNumber;
  return { startLine: sel.startLineNumber, endLine: end };
}

/**
 * A note under its lines, as VS Code's zone widgets do it: an empty view zone makes the room
 * (view zones are `aria-hidden`), an overlay widget on top of it holds the card, so its text
 * and buttons stay reachable for screen readers and the keyboard.
 */
interface ZoneEntry {
  /** Overlay widget content; React portals render the card into it. */
  node: HTMLDivElement;
  widget: Monaco.editor.IOverlayWidget;
  zone: Monaco.editor.IViewZone;
  zoneId: string | null;
  observer: ResizeObserver | null;
  /** The card the observer measures. */
  card: Element | null;
}

const DRAFT_KEY = "draft";
const ZONE_PADDING_PX = 8;

function place(editor: Editor, entry: ZoneEntry): void {
  const layout = editor.getLayoutInfo();
  entry.node.style.top = `${editor.getBottomForLineNumber(entry.zone.afterLineNumber) - editor.getScrollTop()}px`;
  entry.node.style.left = `${layout.contentLeft}px`;
  entry.node.style.width = `${Math.max(0, layout.contentWidth - layout.verticalScrollbarWidth)}px`;
}

function dispose(editor: Editor, entry: ZoneEntry): void {
  entry.observer?.disconnect();
  editor.removeOverlayWidget(entry.widget);
}

export function ReviewZones({ editor, monaco, workspaceId, rel }: { editor: Editor; monaco: MonacoApi; workspaceId: string; rel: string }) {
  const strings = useStrings();
  const all = useReviewStore((s) => s.notes);
  const notes = useMemo(() => all.filter((n) => n.workspaceId === workspaceId && n.rel === rel), [all, workspaceId, rel]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const zones = useRef(new Map<string, ZoneEntry>());
  const [, setZoneVersion] = useState(0);
  const labelRef = useRef(strings.review.addNote);
  labelRef.current = strings.review.addNote;

  // The "+" in the glyph margin follows the mouse; a click on it starts a note (on the selected
  // lines if the click is inside the selection).
  useEffect(() => {
    editor.updateOptions({ glyphMargin: true });
    const hover = editor.createDecorationsCollection();
    const startAt = (line: number) => {
      const sel = editor.getSelection();
      const lines = sel && !sel.isEmpty() ? selectionLines(sel) : null;
      setDraft(lines && line >= lines.startLine && line <= lines.endLine ? lines : { startLine: line, endLine: line });
    };
    const subs = [
      editor.onMouseMove((e) => {
        const line = e.target.position?.lineNumber;
        hover.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: "review-add-glyph", glyphMarginHoverMessage: { value: labelRef.current } } }] : []);
      }),
      editor.onMouseLeave(() => hover.clear()),
      editor.onMouseDown((e) => {
        if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
        const line = e.target.position?.lineNumber;
        if (line) startAt(line);
      }),
    ];
    const action = editor.addAction({
      id: "kotilo.addReviewNote",
      label: labelRef.current,
      keybindings: [monaco.KeyCode.KeyC],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0,
      run: (ed) => {
        const sel = ed.getSelection();
        if (sel) setDraft(selectionLines(sel));
      },
    });
    return () => {
      subs.forEach((d) => d.dispose());
      action.dispose();
      hover.clear();
    };
  }, [editor, monaco]);

  // Open notes tint their lines.
  useEffect(() => {
    const ranges = editor.createDecorationsCollection(
      notes
        .filter((n) => !n.resolved)
        .map((n) => ({ range: new monaco.Range(n.startLine, 1, n.endLine, 1), options: { isWholeLine: true, className: "review-note-range" } })),
    );
    return () => ranges.clear();
  }, [editor, monaco, notes]);

  // Cards follow their zones while the editor scrolls or resizes.
  useEffect(() => {
    const placeAll = () => {
      for (const entry of zones.current.values()) place(editor, entry);
    };
    const subs = [editor.onDidScrollChange(placeAll), editor.onDidLayoutChange(placeAll), editor.onDidContentSizeChange(placeAll)];
    return () => subs.forEach((d) => d.dispose());
  }, [editor]);

  // One zone + card per note (and the draft) under its last line. Entries are kept per id so the
  // React portals inside keep their state when a note moves or changes.
  useEffect(() => {
    const wanted = new Map<string, number>();
    for (const n of notes) wanted.set(n.id, n.endLine);
    if (draft) wanted.set(DRAFT_KEY, draft.endLine);
    const map = zones.current;
    let created = false;
    editor.changeViewZones((acc) => {
      for (const [key, entry] of map) {
        if (wanted.has(key)) continue;
        if (entry.zoneId) acc.removeZone(entry.zoneId);
        dispose(editor, entry);
        map.delete(key);
      }
      for (const [key, line] of wanted) {
        let entry = map.get(key);
        if (!entry) {
          const node = document.createElement("div");
          node.className = "review-zone";
          // Keys and clicks inside a note are the note's own, not the editor's.
          node.addEventListener("keydown", (e) => e.stopPropagation());
          node.addEventListener("mousedown", (e) => e.stopPropagation());
          const widget: Monaco.editor.IOverlayWidget = { getId: () => `kotilo.review.${key}`, getDomNode: () => node, getPosition: () => null };
          const zone: Monaco.editor.IViewZone = {
            afterLineNumber: line,
            heightInPx: 60,
            domNode: document.createElement("div"),
            suppressMouseDown: true,
            onDomNodeTop: (top) => {
              node.style.top = `${top}px`;
            },
          };
          entry = { node, widget, zone, zoneId: null, observer: null, card: null };
          editor.addOverlayWidget(widget);
          map.set(key, entry);
          created = true;
        } else if (entry.zone.afterLineNumber === line && entry.zoneId) {
          continue;
        } else if (entry.zoneId) {
          acc.removeZone(entry.zoneId);
        }
        entry.zone.afterLineNumber = line;
        entry.zoneId = acc.addZone(entry.zone);
      }
    });
    for (const entry of map.values()) place(editor, entry);
    if (created) setZoneVersion((v) => v + 1);
  }, [editor, notes, draft]);

  // Each zone is as tall as its card: measured once the portal has rendered it.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    for (const entry of zones.current.values()) {
      const card = entry.node.firstElementChild;
      if (!card || card === entry.card) continue;
      entry.observer?.disconnect();
      entry.card = card;
      entry.observer = new ResizeObserver(() => {
        if (!entry.zoneId) return;
        const height = (card as HTMLElement).offsetHeight + ZONE_PADDING_PX;
        if (height === entry.zone.heightInPx) return;
        entry.zone.heightInPx = height;
        editor.changeViewZones((a) => a.layoutZone(entry.zoneId!));
        place(editor, entry);
      });
      entry.observer.observe(card);
    }
  });

  useEffect(() => {
    const map = zones.current;
    return () => {
      editor.changeViewZones((acc) => {
        for (const entry of map.values()) {
          if (entry.zoneId) acc.removeZone(entry.zoneId);
          dispose(editor, entry);
        }
      });
      map.clear();
    };
  }, [editor]);

  const save = (text: string) => {
    if (!draft) return;
    if (text.trim() !== "") {
      const lines = editor.getModel()?.getLinesContent() ?? [];
      useReviewStore.getState().add(workspaceId, rel, lines, draft.startLine, draft.endLine, text.trim());
    }
    setDraft(null);
    editor.focus();
  };

  const portals = [];
  for (const n of notes) {
    const node = zones.current.get(n.id)?.node;
    if (node) portals.push(createPortal(<NoteCard note={n} />, node, n.id));
  }
  const draftNode = zones.current.get(DRAFT_KEY)?.node;
  if (draft && draftNode) {
    portals.push(
      createPortal(
        <NoteEditor
          label={strings.review.lines(lineLabel(draft))}
          initial=""
          onSave={save}
          onCancel={() => {
            setDraft(null);
            editor.focus();
          }}
        />,
        draftNode,
        DRAFT_KEY,
      ),
    );
  }
  return <>{portals}</>;
}

function NoteEditor({ label, initial, onSave, onCancel }: { label: string; initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const strings = useStrings();
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSave(text);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };
  return (
    <div className="review-card mx-2 my-1 flex flex-col gap-1.5 rounded-card border border-accent bg-surface-2 p-2 font-ui" data-testid="review-note-editor">
      <span className="text-label text-muted">{label}</span>
      <textarea
        ref={ref}
        value={text}
        rows={2}
        aria-label={strings.review.addNote}
        placeholder={strings.review.placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        className="w-full resize-y rounded-control border border-border bg-surface-3 px-2 py-1.5 text-ui text-text outline-none focus-visible:outline-2 focus-visible:outline-accent"
      />
      <div className="flex justify-end gap-1.5">
        <button type="button" className="header-btn" onClick={onCancel}>
          {strings.review.cancel}
        </button>
        <button type="button" className="header-btn border-accent text-accent" onClick={() => onSave(text)}>
          {strings.review.save}
        </button>
      </div>
    </div>
  );
}

function NoteCard({ note }: { note: ReviewNote }) {
  const strings = useStrings();
  const [editing, setEditing] = useState(false);
  const store = useReviewStore.getState();
  const label = strings.review.lines(lineLabel(note));
  if (editing) {
    return (
      <NoteEditor
        label={label}
        initial={note.text}
        onSave={(text) => {
          if (text.trim() !== "") store.edit(note.id, text.trim());
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <div
      className={`review-card mx-2 my-1 flex flex-col gap-1 rounded-card border bg-surface-2 px-2.5 py-2 font-ui ${note.resolved ? "border-border-subtle opacity-70" : "border-border"}`}
      data-testid="review-note"
      data-resolved={note.resolved}
    >
      <div className="flex flex-wrap items-center gap-2 text-label">
        <span className="whitespace-nowrap text-muted">{label}</span>
        {note.outdated && <span className="rounded-badge bg-working-bg px-1.5 text-working-ink">{strings.review.outdated}</span>}
        {note.resolved && <span className="rounded-badge bg-idle-bg px-1.5 text-idle-ink">{strings.review.resolved}</span>}
        <span className="ml-auto flex gap-1">
          {!note.resolved && (
            <button type="button" className="header-btn" onClick={() => setEditing(true)}>
              {strings.review.edit}
            </button>
          )}
          <button type="button" className="header-btn" onClick={() => store.setResolved(note.id, !note.resolved)}>
            {note.resolved ? strings.review.reopen : strings.review.resolve}
          </button>
          <button type="button" className="header-btn" onClick={() => store.remove(note.id)}>
            {strings.review.delete}
          </button>
        </span>
      </div>
      {!note.resolved && <div className="whitespace-pre-wrap break-words text-ui text-text">{note.text}</div>}
    </div>
  );
}

interface Target {
  agent: Agent;
  label: string;
}

/**
 * Agents running in the workspace's terminals (the pane's own record or a live hub session, as
 * on the pane header), named like the header.
 */
function useTargets(workspaceId: string): Target[] {
  const strings = useStrings();
  const agents = useAgentStore((s) => s.agents);
  const sessions = useHubStore((s) => s.sessions);
  const definitions = useDefinitionsStore((s) => s.definitions);
  const byWorkspace = useTerminalStore((s) => s.byWorkspace);
  return useMemo(() => {
    const tabs = byWorkspace[workspaceId]?.tabs ?? [];
    return tabs.flatMap((tab) => {
      if (tab.status !== "running" || !tab.paneId) return [];
      const paneId = tab.paneId;
      const known = agents.find((a) => a.paneId === paneId);
      const session = matchSession(sessions, paneId, known);
      if (!known && !session) return [];
      const adapterId = session?.agent ?? known?.adapterId ?? null;
      const name = adapterId ? agentDisplayName(adapterId, definitions) : strings.agents.kindLabel[known?.kind ?? "other"];
      const agent: Agent = known ?? { id: paneId, paneId, workspaceId, kind: "other", state: "idle", sinceMs: 0, source: "hook", sessionId: session?.sessionId ?? null };
      // A renamed tab says which one; otherwise only agents of the same kind need a number.
      return [{ agent, name, label: tab.titleEdited ? `${name} · ${tab.title}` : name }];
    }).map((t, _, list) => {
      const same = list.filter((o) => o.label === t.label);
      return { agent: t.agent, label: same.length > 1 ? `${t.label} (${same.indexOf(t) + 1})` : t.label };
    });
  }, [agents, sessions, definitions, byWorkspace, workspaceId, strings]);
}

export function SendNotesButton({ workspaceId }: { workspaceId: string }) {
  const strings = useStrings();
  const count = useOpenNoteCount(workspaceId);
  const targets = useTargets(workspaceId);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  if (count === 0) return <span className="ml-auto truncate text-faint">{strings.review.hint}</span>;

  const send = (target: Target) => {
    const prompt = buildReviewPrompt(openNotes(useReviewStore.getState().notes, workspaceId));
    // Navigate first: it focuses the terminal on the next frame, the composer focuses itself after.
    navigateToAgent(target.agent);
    useComposerInbox.getState().deliver(target.agent.paneId, prompt);
    useToastStore.getState().show(strings.review.sentTo(target.label));
  };

  return (
    <>
      <button
        type="button"
        className="header-btn ml-auto shrink-0"
        disabled={targets.length === 0}
        title={targets.length === 0 ? strings.review.noAgent : undefined}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setMenu({ x: box.left, y: box.bottom + 4, items: targets.map((t) => ({ label: t.label, onClick: () => send(t) })) });
        }}
      >
        {strings.review.sendTo(count)}
      </button>
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </>
  );
}
