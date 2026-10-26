/**
 * D-069: Settings → Quick commands. Add, edit and delete saved shell commands and agent prompts
 * (the composer's saved prompts are the same list), each for every workspace or one folder.
 */
import { useState } from "react";
import { useStrings } from "../../app/i18n";
import type { SavedPrompt } from "../../lib/ipc";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { newPromptId, removeSavedPrompt } from "../composer/composerLogic";
import { kindOf, samePath, upsertQuickCommand, type QuickKind } from "../quickCommands/quickCommandLogic";
import { Button, Field, Select, TextArea, TextInput } from "./controls";

const EMPTY: SavedPrompt[] = [];

interface Draft {
  id: string;
  kind: QuickKind;
  title: string;
  text: string;
  project: string;
}

function QuickCommandForm({ initial, onDone }: { initial: Draft; onDone: () => void }) {
  const s = useStrings();
  const t = s.quickCommands;
  const workspaces = useWorkspaceStore((st) => st.workspaces);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const scopes = [{ value: "", label: t.scopeAll }, ...workspaces.map((w) => ({ value: w.path, label: w.name }))];
  if (draft.project && !workspaces.some((w) => samePath(w.path, draft.project))) {
    scopes.push({ value: draft.project, label: t.scopeMissing(draft.project) });
  }
  const scopeValue = workspaces.find((w) => draft.project && samePath(w.path, draft.project))?.path ?? draft.project;

  function save() {
    if (!draft.text.trim()) {
      setError(t.textRequired);
      return;
    }
    const list = useSettingsStore.getState().settings.composer?.savedPrompts ?? EMPTY;
    const next = upsertQuickCommand(list, { id: draft.id, kind: draft.kind, title: draft.title, text: draft.text, project: draft.project });
    useSettingsStore.getState().update({ composer: { savedPrompts: next } });
    onDone();
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-card border border-border bg-surface-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={t.kind}>
          {(ids) => (
            <Select<QuickKind>
              {...ids}
              value={draft.kind}
              onChange={(kind) => set({ kind })}
              options={[
                { value: "command", label: t.kindCommand },
                { value: "prompt", label: t.kindPrompt },
              ]}
            />
          )}
        </Field>
        <Field label={t.scope}>
          {(ids) => <Select<string> {...ids} value={scopeValue} onChange={(project) => set({ project })} options={scopes} />}
        </Field>
      </div>
      <Field label={t.title}>{(ids) => <TextInput {...ids} value={draft.title} onChange={(title) => set({ title })} placeholder={t.titlePlaceholder} />}</Field>
      <Field label={draft.kind === "command" ? t.command : t.prompt} error={error}>
        {(ids) =>
          draft.kind === "command" ? (
            <TextInput
              {...ids}
              value={draft.text}
              onChange={(text) => {
                set({ text });
                setError(null);
              }}
              placeholder={t.commandPlaceholder}
              className="w-full font-mono"
            />
          ) : (
            <TextArea
              {...ids}
              rows={4}
              value={draft.text}
              onChange={(text) => {
                set({ text });
                setError(null);
              }}
              placeholder={t.promptPlaceholder}
            />
          )
        }
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t.cancel}
        </Button>
        <Button variant="primary" type="submit">
          {t.save}
        </Button>
      </div>
    </form>
  );
}

export function QuickCommandsSection() {
  const s = useStrings();
  const t = s.quickCommands;
  const list = useSettingsStore((st) => st.settings.composer?.savedPrompts ?? EMPTY);
  const workspaces = useWorkspaceStore((st) => st.workspaces);
  const [editing, setEditing] = useState<Draft | null>(null);

  const scopeLabel = (project: string | undefined) => {
    if (!project) return t.scopeAll;
    return workspaces.find((w) => samePath(w.path, project))?.name ?? t.scopeMissing(project);
  };

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <p className="m-0 text-body text-muted">{t.intro}</p>
      {editing && editing.id === "" && (
        <QuickCommandForm initial={{ ...editing, id: newPromptId() }} onDone={() => setEditing(null)} />
      )}
      {!editing && (
        <div>
          <Button variant="primary" onClick={() => setEditing({ id: "", kind: "command", title: "", text: "", project: "" })}>
            {t.add}
          </Button>
        </div>
      )}
      {list.length === 0 && <span className="text-small italic text-muted">{t.empty}</span>}
      <ul aria-label={t.listLabel} className="m-0 flex list-none flex-col gap-1.5 p-0">
        {list.map((entry) =>
          editing?.id === entry.id ? (
            <li key={entry.id}>
              <QuickCommandForm initial={editing} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={entry.id} className="flex items-center gap-2 rounded-control border border-border-subtle bg-surface-3 px-2.5 py-1.5">
              <span className="w-28 shrink-0 text-label font-semibold uppercase tracking-[0.06em] text-faint">
                {kindOf(entry) === "command" ? t.kindCommand : t.kindPrompt}
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body font-semibold text-text">{entry.title}</span>
                <span className={`truncate text-small text-muted ${kindOf(entry) === "command" ? "font-mono" : ""}`}>{entry.text}</span>
              </div>
              <span className="max-w-[10rem] shrink-0 truncate text-small text-text-3" title={entry.project || undefined}>
                {scopeLabel(entry.project)}
              </span>
              <Button
                small
                variant="ghost"
                ariaLabel={`${t.edit}: ${entry.title}`}
                disabled={editing !== null}
                onClick={() => setEditing({ id: entry.id, kind: kindOf(entry), title: entry.title, text: entry.text, project: entry.project ?? "" })}
              >
                {t.edit}
              </Button>
              <Button
                small
                variant="danger"
                ariaLabel={`${t.delete}: ${entry.title}`}
                onClick={() => useSettingsStore.getState().update({ composer: { savedPrompts: removeSavedPrompt(list, entry.id) } })}
              >
                {t.delete}
              </Button>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
