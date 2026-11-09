/**
 * 0.6 worktree dialogs (create + start an agent, compare, merge, remove), mounted once in the
 * app and opened through `useWorktreeStore.openDialog` from the workspace menu, the palette,
 * the terminal panel's "New agent" menu and Mission control.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useStrings } from "../../app/i18n";
import {
  isAppError,
  toAppError,
  worktreeChanges,
  worktreeMerge,
  type GitFileStatus,
  type WorktreeChanges,
  type WorktreeInfo,
  type WorktreeMergeResult,
} from "../../lib/ipc";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useToastStore } from "../../stores/toastStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorktreeStore, type WorktreeDialog } from "../../stores/worktreeStore";
import { useLaunchOptions } from "../agents/launch";
import { Button, Checkbox, Dialog, Field, Notice, Segmented, Select, TextInput } from "../settings/controls";
import { createWorktreeAndStart, openWorktreeDiff, removeWorktreeClosingTabs } from "./worktreeActions";
import {
  DEFAULT_BRANCH_PREFIX,
  defaultSquashMessage,
  deleteBranchDefault,
  mergeMessage,
  offersCleanup,
  removeFollowUp,
  slugify,
  tabsInWorktree,
  unsupportedHint,
  type ResultMessage,
} from "./worktreeLogic";

export function WorktreeDialogs() {
  const dialog = useWorktreeStore((st) => st.dialog);
  const close = useWorktreeStore((st) => st.closeDialog);
  if (!dialog) return null;
  // Keyed so switching dialogs (merge → cleanup) starts with fresh state.
  const key = `${dialog.kind}:${dialog.workspaceId}:${"name" in dialog ? dialog.name : ""}`;
  switch (dialog.kind) {
    case "create":
      return <CreateDialog key={key} workspaceId={dialog.workspaceId} onClose={close} />;
    case "compare":
      return <CompareDialog key={key} dialog={dialog} onClose={close} />;
    case "merge":
      return <MergeDialog key={key} dialog={dialog} onClose={close} />;
    case "remove":
      return <RemoveDialog key={key} dialog={dialog} onClose={close} />;
  }
}

function useWorktree(workspaceId: string, name: string): WorktreeInfo | null {
  return useWorktreeStore((st) => st.byWorkspace[workspaceId]?.list?.worktrees.find((w) => w.name === name) ?? null);
}

function ResultNotice({ message }: { message: ResultMessage }) {
  return (
    <div data-testid="worktree-result" data-tone={message.tone}>
      <Notice tone={message.tone === "error" ? "error" : "info"}>{message.text}</Notice>
    </div>
  );
}

function GitDetail({ detail }: { detail: string | null }) {
  const s = useStrings();
  if (!detail) return null;
  return (
    <details className="text-meta text-muted">
      <summary className="cursor-pointer">{s.worktrees.merge.detail}</summary>
      <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-control bg-terminal p-2 font-mono text-label text-text-2">{detail}</pre>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Create

function CreateDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const s = useStrings();
  const t = s.worktrees.create;
  const launch = useLaunchOptions();
  const prefix = useSettingsStore((st) => st.settings.worktrees?.branchPrefix ?? DEFAULT_BRANCH_PREFIX);
  const workspaceName = useWorkspaceStore((st) => st.workspaces.find((w) => w.id === workspaceId)?.name ?? "");
  const list = useWorktreeStore((st) => st.byWorkspace[workspaceId]?.list ?? null);
  const [name, setName] = useState("");
  const [agent, setAgent] = useState<string>(launch[0]?.command ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => useWorktreeStore.getState().ensure(workspaceId), [workspaceId]);

  const slug = slugify(name);
  const invalid = name.trim() !== "" && slug === "";
  const unsupported = list !== null && !list.supported;
  const canSubmit = slug !== "" && !busy && !unsupported;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await createWorktreeAndStart(workspaceId, name.trim(), agent || null);
      onClose();
    } catch (err) {
      setBusy(false);
      if (isAppError(err, "already_exists")) setError(t.alreadyExists);
      else if (isAppError(err, "invalid_name")) setError(s.worktrees.create.nameInvalid);
      else setError(t.failed(toAppError(err).message));
    }
  }

  return (
    <Dialog
      title={t.title}
      onCancel={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {s.worktrees.merge.cancel}
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? t.creating : t.submit}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        {workspaceName && <span className="text-meta text-muted">{`${t.workspace}: ${workspaceName}`}</span>}
        {unsupported && <Notice tone="warning">{unsupportedHint(s, list.reason)}</Notice>}
        <Field label={t.name} hint={slug ? t.nameHint(slug, `${prefix}${slug}`) : undefined} error={invalid ? t.nameInvalid : null}>
          {(ids) => <TextInput {...ids} value={name} onChange={setName} placeholder={t.namePlaceholder} />}
        </Field>
        <Field label={t.agent}>
          {(ids) => (
            <Select<string>
              {...ids}
              value={agent}
              onChange={setAgent}
              options={[...launch.map((o) => ({ value: o.command, label: o.label })), { value: "", label: t.shellOnly }]}
            />
          )}
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Compare

const STATUS_CLASS: Record<GitFileStatus, string> = {
  M: "text-working-ink",
  A: "text-idle-ink",
  "?": "text-idle-ink",
  D: "text-blocked-ink",
  R: "text-done-ink",
};

type CompareState = { status: "loading" } | { status: "ready"; changes: WorktreeChanges } | { status: "failed" };

function CompareDialog({ dialog, onClose }: { dialog: Extract<WorktreeDialog, { kind: "compare" }>; onClose: () => void }) {
  const s = useStrings();
  const t = s.worktrees.compare;
  const wt = useWorktree(dialog.workspaceId, dialog.name);
  const [state, setState] = useState<CompareState>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    worktreeChanges(dialog.workspaceId, dialog.name).then(
      (changes) => alive && setState({ status: "ready", changes }),
      () => alive && setState({ status: "failed" }),
    );
    return () => {
      alive = false;
    };
  }, [dialog.workspaceId, dialog.name]);

  const branch = wt?.branch ?? dialog.name;
  const prefix = wt ? `${wt.rel}/` : "";

  return (
    <Dialog
      title={t.title(branch)}
      onCancel={onClose}
      wide
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t.close}
        </Button>
      }
    >
      {state.status === "loading" && <p className="m-0 text-body text-muted">{t.loading}</p>}
      {state.status === "failed" && <Notice tone="error">{t.failed}</Notice>}
      {state.status === "ready" && (
        <div className="flex flex-col gap-2.5">
          <p className="m-0 text-body text-muted">{state.changes.base ? t.subtitle(wt?.base ?? "HEAD") : t.noBase}</p>
          {state.changes.files.length === 0 ? (
            <p className="m-0 text-body text-muted">{t.none}</p>
          ) : (
            <ul className="m-0 flex max-h-[50vh] list-none flex-col overflow-auto rounded-control border border-border-subtle bg-surface-3 p-1" data-testid="worktree-changes">
              {state.changes.files.map((f) => {
                const shown = f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path;
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      aria-label={t.openDiff(shown)}
                      className="flex w-full items-center gap-2 rounded-control px-2 py-1 text-left font-mono text-small hover:bg-surface-4"
                      onClick={() => {
                        openWorktreeDiff(dialog.workspaceId, f.path, state.changes.base);
                        onClose();
                      }}
                    >
                      <span className={`w-3 shrink-0 text-label font-semibold ${STATUS_CLASS[f.status]}`}>{f.status === "?" ? "U" : f.status}</span>
                      <span className="min-w-0 flex-1 truncate text-text-2">{shown}</span>
                      {f.added !== null && <span className="text-idle-ink">+{f.added}</span>}
                      {f.removed !== null && <span className="text-blocked-ink">−{f.removed}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {state.changes.truncated && <p className="m-0 text-meta text-muted">{t.truncated}</p>}
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Merge

function MergeDialog({ dialog, onClose }: { dialog: Extract<WorktreeDialog, { kind: "merge" }>; onClose: () => void }) {
  const s = useStrings();
  const t = s.worktrees.merge;
  const wt = useWorktree(dialog.workspaceId, dialog.name);
  const openDialog = useWorktreeStore((st) => st.openDialog);
  const branch = wt?.branch ?? dialog.name;
  const base = wt?.base ?? "";
  const [mode, setMode] = useState<"normal" | "squash">("normal");
  const [message, setMessage] = useState(defaultSquashMessage(branch));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WorktreeMergeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const done = result !== null && offersCleanup(result);
  const text = result ? mergeMessage(s, result, branch, base) : null;

  async function merge() {
    setBusy(true);
    setError(null);
    try {
      const r = await worktreeMerge(dialog.workspaceId, dialog.name, { squash: mode === "squash", message: mode === "squash" ? message.trim() || null : null });
      setResult(r);
      if (r.status === "merged") useToastStore.getState().show(t.result.merged(branch, base));
    } catch (err) {
      setError(toAppError(err).message);
    } finally {
      setBusy(false);
      void useWorktreeStore.getState().refresh(dialog.workspaceId);
    }
  }

  return (
    <Dialog
      title={t.title(branch, base || "…")}
      onCancel={onClose}
      footer={
        done ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t.close}
            </Button>
            <Button variant="primary" onClick={() => openDialog({ kind: "remove", workspaceId: dialog.workspaceId, name: dialog.name })}>
              {t.cleanup}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button variant="primary" disabled={busy || !base} onClick={() => void merge()}>
              {busy ? t.merging : t.submit}
            </Button>
          </>
        )
      }
    >
      {!base && <Notice tone="warning">{t.noBase}</Notice>}
      {!done && (
        <>
          <p className="m-0 text-body text-muted">{t.intro}</p>
          <div className="flex flex-col gap-1.5">
            <Segmented
              ariaLabel={t.mode}
              value={mode}
              onChange={setMode}
              options={[
                { value: "normal", label: t.normal },
                { value: "squash", label: t.squash },
              ]}
            />
            <span className="text-meta text-muted">{mode === "squash" ? t.squashHint : t.normalHint}</span>
          </div>
          {mode === "squash" && (
            <Field label={t.message}>{(ids) => <TextInput {...ids} value={message} onChange={setMessage} />}</Field>
          )}
        </>
      )}
      {text && <ResultNotice message={text} />}
      {result?.status === "conflict" && result.conflicts.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-small font-medium text-text-3">{t.result.conflictFiles}</span>
          <ul className="m-0 list-none rounded-control border border-border-subtle bg-surface-3 p-2 font-mono text-small text-blocked-ink" data-testid="merge-conflicts">
            {result.conflicts.map((path) => (
              <li key={path} className="truncate">
                {path}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result && result.status !== "merged" && result.status !== "upToDate" && <GitDetail detail={result.detail} />}
      {done && <p className="m-0 text-body text-text-2">{t.cleanupOffer}</p>}
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Remove

function RemoveDialog({ dialog, onClose }: { dialog: Extract<WorktreeDialog, { kind: "remove" }>; onClose: () => void }) {
  const s = useStrings();
  const t = s.worktrees.remove;
  const wt = useWorktree(dialog.workspaceId, dialog.name);
  const tabs = useTerminalStore((st) => st.byWorkspace[dialog.workspaceId]?.tabs);
  const tabCount = useMemo(() => (wt ? tabsInWorktree(tabs ?? [], wt.rel).length : 0), [tabs, wt]);
  // Snapshot of the worktree when the dialog opened: the list refreshes (and drops it) on removal.
  const [info] = useState(wt);
  const branch = info?.branch ?? null;
  const [deleteBranch, setDeleteBranch] = useState(info ? deleteBranchDefault(info) : false);
  const [refused, setRefused] = useState<{ dirty: boolean; unmerged: boolean }>({ dirty: false, unmerged: false });
  const [force, setForce] = useState(false);
  const [forceBranch, setForceBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ detail: string | null } | null>(null);

  // A dirty worktree or an unmerged branch needs an explicit tick before anything is closed.
  const askForce = (info?.dirty ?? 0) > 0 || refused.dirty;
  const askForceBranch = deleteBranch && branch !== null && ((info?.ahead ?? 0) > 0 || refused.unmerged);
  const canSubmit = !busy && info !== null && (!askForce || force) && (!askForceBranch || forceBranch);

  async function remove() {
    if (!info || !canSubmit) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await removeWorktreeClosingTabs(dialog.workspaceId, info, {
        force: askForce && force,
        deleteBranch: deleteBranch && branch !== null,
        forceBranch: askForceBranch && forceBranch,
      });
      switch (removeFollowUp(result)) {
        case "done":
          useToastStore.getState().show(result.branchDeleted && branch ? t.removedWithBranch(info.name, branch) : t.removed(info.name));
          onClose();
          return;
        case "confirmForce":
          setRefused((r) => ({ ...r, dirty: true }));
          setForce(false);
          break;
        case "confirmForceBranch":
          setRefused((r) => ({ ...r, unmerged: true }));
          setForceBranch(false);
          break;
        case "failed":
          setFailure({ detail: result.detail });
          break;
      }
    } catch (err) {
      setFailure({ detail: toAppError(err).message });
    }
    setBusy(false);
  }

  return (
    <Dialog
      title={t.title(info?.name ?? dialog.name)}
      onCancel={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button variant="danger" disabled={!canSubmit} onClick={() => void remove()}>
            {busy ? t.removing : t.submit}
          </Button>
        </>
      }
    >
      <p className="m-0 text-body text-text-2">{t.body}</p>
      {tabCount > 0 && <Notice tone="warning">{t.closesTabs(tabCount)}</Notice>}
      {branch && <Checkbox checked={deleteBranch} onChange={setDeleteBranch} label={t.deleteBranch(branch)} />}
      {askForce && (
        <div className="flex flex-col gap-2" data-testid="remove-confirm-dirty">
          <Notice tone="error">{info && info.dirty > 0 ? t.dirty(info.dirty) : t.dirtyUnknown}</Notice>
          <Checkbox checked={force} onChange={setForce} label={t.forceRemove} />
        </div>
      )}
      {askForceBranch && branch && (
        <div className="flex flex-col gap-2" data-testid="remove-confirm-unmerged">
          <Notice tone="error">{t.unmerged(branch)}</Notice>
          <Checkbox checked={forceBranch} onChange={setForceBranch} label={t.forceBranch} />
        </div>
      )}
      {failure && (
        <>
          <Notice tone="error">{t.failed}</Notice>
          <GitDetail detail={failure.detail} />
        </>
      )}
    </Dialog>
  );
}
