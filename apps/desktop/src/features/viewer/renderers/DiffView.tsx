/**
 * M4 diff tab: HEAD (left) vs the working copy on disk (right), read-only Monaco DiffEditor.
 * Opened from the timeline rail's changed files. Added/untracked files diff against nothing,
 * deleted ones against an empty right side. Reloads on `fs:changed` for the file's folder.
 * Rule 5: the contents stay in this component's memory; nothing is logged or persisted.
 * D-066: review notes on the working-copy side (`features/review`), sent to an agent.
 * 0.6: `rev` puts that commit on the left instead of HEAD (worktree compare: the merge-base);
 * the path may lie inside a worktree, whose repo Rust reads it from.
 */
import { useEffect, useState } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { useStrings } from "../../../app/strings";
import { useResolvedTheme } from "../../../app/theme/resolvedTheme";
import { fsReadText, gitShowHead, isAppError, onFsChanged } from "../../../lib/ipc";
import { isSameOrDescendant, parentRel } from "../../workspaces/paths";
import { languageForRel, monacoThemeFor } from "./TextEditor";
import type { RendererProps } from "./types";
import { ReviewZones, SendNotesButton } from "../../review/DiffReview";
import { linesOf } from "../../review/reviewNotes";
import { useReviewStore } from "../../review/reviewStore";

type Mounted = { editor: Parameters<DiffOnMount>[0]; monaco: Parameters<DiffOnMount>[1] };

const RELOAD_DEBOUNCE_MS = 300;

type DiffState =
  | { status: "loading" }
  | { status: "ready"; original: string; modified: string }
  | { status: "binary" | "tooLarge" | "failed" };

export async function loadDiff(workspaceId: string, rel: string, rev?: string): Promise<DiffState> {
  try {
    const [head, work] = await Promise.all([
      gitShowHead(workspaceId, rel, rev),
      fsReadText(workspaceId, rel).catch((e: unknown) => {
        if (isAppError(e, "not_found")) return null; // deleted in the working copy
        if (isAppError(e, "binary_file")) return "binary" as const;
        throw e;
      }),
    ]);
    if (head.binary || work === "binary") return { status: "binary" };
    if (head.tooLarge) return { status: "tooLarge" };
    return { status: "ready", original: head.content ?? "", modified: work?.text ?? "" };
  } catch {
    return { status: "failed" };
  }
}

export function DiffView({ workspaceId, rel, rev }: RendererProps & { rev?: string }) {
  const strings = useStrings();
  const theme = useResolvedTheme((s) => s.theme);
  const [state, setState] = useState<DiffState>({ status: "loading" });
  const [mounted, setMounted] = useState<Mounted | null>(null);
  // A diff that left "ready" unmounted its editor; the next mount reports the new one.
  useEffect(() => {
    if (state.status !== "ready") setMounted(null);
  }, [state.status]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      void loadDiff(workspaceId, rel, rev).then((next) => {
        if (!alive) return;
        if (next.status === "ready") useReviewStore.getState().reanchorFile(workspaceId, rel, linesOf(next.modified));
        setState(next);
      });
    load();
    const unlisten = onFsChanged(({ workspaceId: ws, dirs }) => {
      if (ws !== workspaceId || !dirs.some((d) => isSameOrDescendant(parentRel(rel), d))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, RELOAD_DEBOUNCE_MS);
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      void unlisten.then((fn) => fn());
    };
  }, [workspaceId, rel, rev]);

  const message =
    state.status === "binary"
      ? strings.timeline.diffBinary
      : state.status === "tooLarge"
        ? strings.timeline.diffTooLarge
        : state.status === "failed"
          ? strings.timeline.diffFailed
          : null;

  return (
    <div className="flex h-full flex-col" data-testid="diff-view">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-label text-muted">
        <span className="truncate font-mono text-text-2">{rel}</span>
        <span className="shrink-0">{rev ? strings.timeline.diffHeaderRev(rev.slice(0, 8)) : strings.timeline.diffHeader}</span>
        {state.status === "ready" && <SendNotesButton workspaceId={workspaceId} />}
      </div>
      <div className="min-h-0 flex-1">
        {state.status === "loading" ? (
          <div className="p-3 text-xs text-muted">{strings.timeline.loading}</div>
        ) : message ? (
          <div className="p-3 text-xs text-muted">{message}</div>
        ) : state.status === "ready" ? (
          <DiffEditor
            theme={monacoThemeFor(theme)}
            language={languageForRel(rel)}
            original={state.original}
            modified={state.modified}
            // Own path spaces: TextEditor models start with "/", the compare banner uses `compare-*:`.
            originalModelPath={`diff-head:${workspaceId}/${rev ? `${rev}/` : ""}${rel}`}
            modifiedModelPath={`diff-work:${workspaceId}/${rel}`}
            options={{ readOnly: true, originalEditable: false, renderSideBySide: true, automaticLayout: true }}
            onMount={(editor, monaco) => setMounted({ editor, monaco })}
          />
        ) : null}
        {state.status === "ready" && mounted && (
          <ReviewZones editor={mounted.editor.getModifiedEditor()} monaco={mounted.monaco} workspaceId={workspaceId} rel={rel} />
        )}
      </div>
    </div>
  );
}
