/**
 * Tasks screen (M2, CCC spec §21.2): personal notes and to-dos kept by the hub. Quick add
 * (Enter = general note, no due date), "New task" dialog, Open / Completed / All, search,
 * groups (general notes first, then projects), edit on click, delete with confirmation.
 */
import { useEffect, useMemo, useState } from "react";
import { useStrings } from "../../app/i18n";
import { ConfirmModal } from "../../app/ConfirmModal";
import { hubRequest } from "../../lib/ipc";
import type { PersonalTask, ProjectDto, TaskInput, TaskPriority } from "../../lib/hubTypes";
import { useToastStore } from "../../stores/toastStore";
import { Button, Card, Dialog, EmptyState, Field, Notice, Page, PageHeader, SectionLabel, Segmented, Select, TextArea, TextInput } from "../settings/controls";
import { asAppError, useHubResource } from "../settings/hubData";
import { formatDue, formatRelative, groupTasks, isoDatePlusDays, splitNote } from "./taskLogic";
import { formatKeybinding, isModPressed } from "../../lib/keys";

type Filter = "open" | "done" | "all";

/** Editor state for the dialog: `id` null = new task. */
interface Draft {
  id: number | null;
  text: string;
  dueDate: string;
  dueTime: string;
  projectRoot: string;
  priority: TaskPriority;
}

const EMPTY_DRAFT: Draft = { id: null, text: "", dueDate: "", dueTime: "", projectRoot: "", priority: "normal" };

function draftFrom(task: PersonalTask): Draft {
  return {
    id: task.id,
    text: task.text,
    dueDate: task.dueDate ?? "",
    dueTime: task.dueTime ?? "",
    projectRoot: task.projectRoot ?? "",
    priority: task.priority,
  };
}

function inputFrom(draft: Draft): TaskInput {
  return {
    text: draft.text.trim(),
    dueDate: draft.dueDate || null,
    dueTime: draft.dueDate && draft.dueTime ? draft.dueTime : null,
    projectRoot: draft.projectRoot || null,
    priority: draft.priority,
  };
}

export function TasksPage() {
  const s = useStrings();
  const [filter, setFilter] = useState<Filter>("open");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [quick, setQuick] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toDelete, setToDelete] = useState<PersonalTask | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const path = `/v1/tasks?filter=${filter}${debouncedQuery ? `&q=${encodeURIComponent(debouncedQuery)}` : ""}`;
  const tasks = useHubResource<PersonalTask[]>(path);
  const projects = useHubResource<ProjectDto[]>("/v1/projects");
  const groups = useMemo(() => groupTasks(tasks.data ?? []), [tasks.data]);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await tasks.reload();
    } catch (e) {
      useToastStore.getState().show(asAppError(e).message);
    }
  }

  function quickAdd() {
    const text = quick.trim();
    if (!text) return;
    setQuick("");
    void run(() => hubRequest<PersonalTask>("POST", "/v1/tasks", { text } satisfies TaskInput));
  }

  return (
    <Page>
      <PageHeader title={s.tasks.title} subtitle={s.tasks.subtitle} actions={<Button variant="primary" onClick={() => setDraft(EMPTY_DRAFT)}>{s.tasks.newTask}</Button>} />

      <TextInput
        value={quick}
        onChange={setQuick}
        ariaLabel={s.tasks.quickAddLabel}
        placeholder={s.tasks.quickAddPlaceholder}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            quickAdd();
          }
        }}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={filter}
          onChange={setFilter}
          ariaLabel={s.tasks.filterLabel}
          options={[
            { value: "open", label: s.tasks.filters.open },
            { value: "done", label: s.tasks.filters.done },
            { value: "all", label: s.tasks.filters.all },
          ]}
        />
        <div className="min-w-[220px] flex-1">
          <TextInput type="search" value={query} onChange={setQuery} ariaLabel={s.tasks.searchLabel} placeholder={s.tasks.searchPlaceholder} />
        </div>
      </div>

      {tasks.unavailable && <Notice tone="warning">{s.errors.forCode("hub_unavailable")}</Notice>}
      {tasks.error && !tasks.unavailable && <Notice tone="error">{tasks.error.message}</Notice>}

      {tasks.data && groups.length === 0 && <EmptyState title={s.tasks.empty[filter]} />}

      {groups.map((group) => {
        const labelId = `tasks-group-${group.projectRoot ?? "general"}`;
        return (
          <section key={group.projectRoot ?? "general"} aria-labelledby={labelId} className="flex flex-col gap-2">
            <SectionLabel id={labelId}>{group.projectName ?? s.tasks.generalNotes}</SectionLabel>
            <Card>
              <ul className="m-0 flex list-none flex-col p-0">
                {group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onToggle={() => void run(() => hubRequest("POST", `/v1/tasks/${task.id}/complete`, { completed: task.completedAt === null }))}
                    onEdit={() => setDraft(draftFrom(task))}
                    onDelete={() => setToDelete(task)}
                  />
                ))}
              </ul>
            </Card>
          </section>
        );
      })}

      {draft && (
        <TaskEditor
          draft={draft}
          projects={projects.data ?? []}
          onCancel={() => setDraft(null)}
          onSave={(d) => {
            setDraft(null);
            const body = inputFrom(d);
            void run(() => (d.id === null ? hubRequest("POST", "/v1/tasks", body) : hubRequest("PUT", `/v1/tasks/${d.id}`, body)));
          }}
        />
      )}

      {toDelete && (
        <ConfirmModal
          title={s.tasks.deleteTitle}
          body={s.tasks.deleteBody(toDelete.title)}
          confirmLabel={s.tasks.delete}
          onCancel={() => setToDelete(null)}
          onConfirm={() => {
            const id = toDelete.id;
            setToDelete(null);
            void run(() => hubRequest("DELETE", `/v1/tasks/${id}`));
          }}
        />
      )}
    </Page>
  );
}

function TaskRow({ task, onToggle, onEdit, onDelete }: { task: PersonalTask; onToggle: () => void; onEdit: () => void; onDelete: () => void }) {
  const s = useStrings();
  const done = task.completedAt !== null;
  const due = formatDue(task);
  const dueClass =
    task.dueState === "overdue" ? "bg-blocked-bg text-blocked-ink" : task.dueState === "today" ? "bg-working-bg text-working-ink" : "bg-surface-5 text-text-3";

  return (
    <li className="flex items-start gap-3 border-b border-border-subtle px-4 py-3 last:border-b-0">
      <input
        type="checkbox"
        checked={done}
        onChange={onToggle}
        aria-label={done ? s.tasks.markOpen(task.title) : s.tasks.markDone(task.title)}
        className="mt-1 size-4 accent-accent"
      />
      <button
        type="button"
        onClick={onEdit}
        className="flex min-w-0 flex-1 flex-col items-start gap-1 rounded-control bg-transparent p-0 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className={`text-ui font-medium ${done ? "text-muted line-through" : "text-text"}`}>{task.title}</span>
        {task.details && <span className="line-clamp-3 whitespace-pre-line text-small text-muted">{task.details}</span>}
        <span className="flex flex-wrap items-center gap-2 text-meta text-muted">
          {due && !done && (
            <span className={`rounded-badge px-1.5 py-0.5 font-mono ${dueClass}`}>
              {task.dueState === "overdue" ? `${s.tasks.overdue} · ` : ""}
              {due}
            </span>
          )}
          {task.priority !== "normal" && (
            <span className={`rounded-badge px-1.5 py-0.5 ${task.priority === "high" ? "bg-blocked-bg text-blocked-ink" : "bg-surface-5 text-text-3"}`}>
              {s.tasks.priorityBadge(s.tasks.priorities[task.priority])}
            </span>
          )}
          <span>{done && task.completedAt ? s.tasks.completed(formatRelative(task.completedAt)) : s.tasks.added(formatRelative(task.createdAt))}</span>
        </span>
      </button>
      <Button variant="ghost" small onClick={onDelete} ariaLabel={`${s.tasks.delete}: ${task.title}`}>
        {s.tasks.delete}
      </Button>
    </li>
  );
}

function TaskEditor({ draft, projects, onCancel, onSave }: { draft: Draft; projects: ProjectDto[]; onCancel: () => void; onSave: (d: Draft) => void }) {
  const s = useStrings();
  const [d, setD] = useState<Draft>(draft);
  const [tried, setTried] = useState(false);
  const noteError = tried && splitNote(d.text).title === "" ? s.tasks.noteRequired : null;
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));

  function save() {
    setTried(true);
    if (splitNote(d.text).title === "") return;
    onSave(d);
  }

  return (
    <Dialog
      title={d.id === null ? s.tasks.newTask : s.tasks.editTask}
      onCancel={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{s.tasks.cancel}</Button>
          <Button variant="primary" onClick={save}>
            {s.tasks.save} <span className="font-mono text-label opacity-60">{formatKeybinding("Mod+Enter").replace("+", " ")}</span>
          </Button>
        </>
      }
    >
      <div
        className="flex flex-col gap-4"
        onKeyDown={(e) => {
          if (e.key === "Enter" && isModPressed(e)) {
            e.preventDefault();
            save();
          }
        }}
      >
        <Field label={s.tasks.noteLabel} hint={s.tasks.noteHint} error={noteError}>
          {(ids) => <TextArea {...ids} rows={4} value={d.text} onChange={(text) => set({ text })} />}
        </Field>
        <Field label={s.tasks.dueLabel}>
          {(ids) => (
            <div className="flex flex-wrap items-center gap-2">
              <TextInput {...ids} type="date" className="w-40" value={d.dueDate} onChange={(dueDate) => set({ dueDate })} />
              <Button small onClick={() => set({ dueDate: isoDatePlusDays(0) })}>{s.tasks.dueToday}</Button>
              <Button small onClick={() => set({ dueDate: isoDatePlusDays(1) })}>{s.tasks.dueTomorrow}</Button>
              <Button small onClick={() => set({ dueDate: isoDatePlusDays(7) })}>{s.tasks.dueWeek}</Button>
              <Button small variant="ghost" onClick={() => set({ dueDate: "", dueTime: "" })}>{s.tasks.dueClear}</Button>
            </div>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={s.tasks.timeLabel} hint={s.tasks.timeHint}>
            {(ids) => <TextInput {...ids} type="time" value={d.dueTime} onChange={(dueTime) => set({ dueTime })} />}
          </Field>
          <Field label={s.tasks.priorityLabel}>
            {(ids) => (
              <Select<TaskPriority>
                {...ids}
                value={d.priority}
                onChange={(priority) => set({ priority })}
                options={[
                  { value: "low", label: s.tasks.priorities.low },
                  { value: "normal", label: s.tasks.priorities.normal },
                  { value: "high", label: s.tasks.priorities.high },
                ]}
              />
            )}
          </Field>
        </div>
        <Field label={s.tasks.projectLabel}>
          {(ids) => (
            <Select<string>
              {...ids}
              value={d.projectRoot}
              onChange={(projectRoot) => set({ projectRoot })}
              options={[{ value: "", label: s.tasks.generalNotes }, ...projects.map((p) => ({ value: p.root, label: p.name }))]}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
