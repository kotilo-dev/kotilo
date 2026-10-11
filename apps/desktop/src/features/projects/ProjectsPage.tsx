/**
 * Projects screen (M2, CCC spec §12.3): projects with todo progress and git status; the
 * selected project's todo files with per-heading progress and the next open item. A todo file
 * opens in our viewer when the project lives in a workspace (otherwise the project can be
 * added as one). Display name, customer and hidden flag are edited through the hub.
 */
import { useEffect, useMemo, useState } from "react";
import { formatNumber, useStrings } from "../../app/i18n";
import { hubRequest, pickFolders } from "../../lib/ipc";
import type { Customer, ProjectDto, TodoFileDto } from "../../lib/hubTypes";
import { useRouteStore } from "../../stores/routeStore";
import { useToastStore } from "../../stores/toastStore";
import { useViewerStore } from "../../stores/viewerStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { formatRelative } from "../tasks/taskLogic";
import { Button, Card, Checkbox, EmptyState, Field, Notice, Page, PageHeader, ProgressBar, SectionLabel, Select, TextInput } from "../settings/controls";
import { asAppError, useHubResource } from "../settings/hubData";
import { findWorkspaceFile, joinProjectPath } from "./projectLogic";

export function ProjectsPage() {
  const s = useStrings();
  const [showHidden, setShowHidden] = useState(false);
  const projects = useHubResource<ProjectDto[]>(`/v1/projects${showHidden ? "?includeHidden=true" : ""}`);
  const customers = useHubResource<Customer[]>("/v1/customers");
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const selected = projects.data?.find((p) => p.root === selectedRoot) ?? null;

  useEffect(() => {
    if (selectedRoot === null && projects.data && projects.data.length > 0) setSelectedRoot(projects.data[0]!.root);
  }, [projects.data, selectedRoot]);

  async function addFolder() {
    const [folder] = await pickFolders(s.projects.addFolderTitle);
    if (!folder) return;
    try {
      const { root } = await hubRequest<{ root: string }>("POST", "/v1/projects/folders", { path: folder });
      await projects.reload();
      setSelectedRoot(root);
    } catch (e) {
      useToastStore.getState().show(asAppError(e).message);
    }
  }

  return (
    <Page>
      <PageHeader
        title={s.projects.title}
        subtitle={projects.data ? s.projects.subtitle(projects.data.length) : undefined}
        actions={
          <>
            <Checkbox checked={showHidden} onChange={setShowHidden} label={s.projects.showHidden} />
            <Button onClick={() => void addFolder()}>{s.projects.addFolder}</Button>
          </>
        }
      />
      {projects.unavailable && <Notice tone="warning">{s.errors.forCode("hub_unavailable")}</Notice>}
      {projects.error && !projects.unavailable && <Notice tone="error">{projects.error.message}</Notice>}
      {projects.data && projects.data.length === 0 && <EmptyState title={s.projects.empty} body={s.projects.emptyBody} />}

      {projects.data && projects.data.length > 0 && (
        <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(280px,380px)_1fr]">
          <nav aria-label={s.projects.listLabel}>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {projects.data.map((p) => (
                <li key={p.root}>
                  <ProjectListItem project={p} selected={p.root === selectedRoot} onSelect={() => setSelectedRoot(p.root)} />
                </li>
              ))}
            </ul>
          </nav>
          {selected ? (
            <ProjectDetail key={selected.root} project={selected} customers={customers.data ?? []} onChanged={() => void projects.reload()} />
          ) : (
            <EmptyState title={s.projects.selectPrompt} />
          )}
        </div>
      )}
    </Page>
  );
}

function GitSummary({ git }: { git: NonNullable<ProjectDto["git"]> }) {
  const s = useStrings();
  return (
    <span className="flex items-center gap-2 font-mono text-meta text-muted">
      <span>{git.isDetached ? s.projects.detached : git.branch}</span>
      <span className={git.changed > 0 ? "text-working-ink" : ""}>{git.changed > 0 ? s.projects.gitChanged(git.changed) : s.projects.gitClean}</span>
      {git.ahead > 0 && <span>{s.projects.gitAhead(git.ahead)}</span>}
      {git.behind > 0 && <span>{s.projects.gitBehind(git.behind)}</span>}
    </span>
  );
}

function ProjectListItem({ project: p, selected, onSelect }: { project: ProjectDto; selected: boolean; onSelect: () => void }) {
  const s = useStrings();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={`flex w-full flex-col gap-2 rounded-card border px-3.5 py-3 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        selected ? "border-accent bg-surface-4" : "border-border-subtle bg-surface-2 hover:bg-surface-3"
      }`}
    >
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-text">{p.name}</span>
        {p.hidden && <span className="rounded-badge bg-surface-5 px-1.5 py-0.5 text-label text-text-3">{s.projects.hiddenBadge}</span>}
        <span className="font-mono text-small text-text-2">{p.total > 0 ? `${formatNumber(Math.round(p.percent))}%` : ""}</span>
      </span>
      {p.total > 0 ? <ProgressBar value={p.percent} label={s.projects.progress(p.done, p.total)} /> : <span className="text-meta text-muted">{s.projects.noTodo}</span>}
      <span className="flex flex-wrap items-center justify-between gap-2">
        {p.git ? <GitSummary git={p.git} /> : <span />}
        <span className="text-meta text-muted">{p.lastActivity ? formatRelative(p.lastActivity) : s.projects.never}</span>
      </span>
    </button>
  );
}

function ProjectDetail({ project: p, customers, onChanged }: { project: ProjectDto; customers: Customer[]; onChanged: () => void }) {
  const s = useStrings();
  const files = useHubResource<TodoFileDto[]>(`/v1/projects/files?root=${encodeURIComponent(p.root)}`);
  const workspaces = useWorkspaceStore((st) => st.workspaces);
  const addWorkspace = useWorkspaceStore((st) => st.addWorkspace);
  const inWorkspace = useMemo(() => findWorkspaceFile(workspaces, joinProjectPath(p.root, "x")) !== null, [workspaces, p.root]);

  function openFile(relativePath: string, line?: number) {
    const target = findWorkspaceFile(useWorkspaceStore.getState().workspaces, joinProjectPath(p.root, relativePath));
    if (!target) return;
    void useWorkspaceStore.getState().setActive(target.workspaceId);
    useViewerStore.getState().openFile(target.workspaceId, target.rel, { pinned: true, line });
    useRouteStore.getState().navigate("workspace");
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ProjectEditor project={p} customers={customers} onChanged={onChanged} />
      {!inWorkspace && (
        <Notice>
          <span className="flex flex-wrap items-center gap-3">
            {s.projects.notInWorkspace}
            <Button small onClick={() => void addWorkspace(p.root)}>
              {s.projects.addAsWorkspace}
            </Button>
          </span>
        </Notice>
      )}
      {p.next && (
        <Card className="flex flex-col gap-1 p-4">
          <SectionLabel>{s.projects.next}</SectionLabel>
          <span className="text-ui text-text">{p.next.text}</span>
          <span className="font-mono text-meta text-muted">
            {p.next.file}
            {p.next.group ? ` · ${p.next.group}` : ""}
          </span>
        </Card>
      )}
      <section aria-labelledby="project-files" className="flex flex-col gap-2">
        <SectionLabel id="project-files">{s.projects.todoFiles}</SectionLabel>
        {files.error && <Notice tone="error">{files.error.message}</Notice>}
        {files.data && files.data.length === 0 && <EmptyState title={s.projects.noFiles} />}
        {(files.data ?? []).map((f) => (
          <Card key={f.relativePath} className="flex flex-col gap-3 p-4">
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate font-mono text-body text-text">{f.relativePath}</span>
              <span className="font-mono text-small text-text-2">{s.projects.progress(f.done, f.total)}</span>
              <Button small disabled={!inWorkspace} ariaLabel={s.projects.openFileLabel(f.relativePath)} onClick={() => openFile(f.relativePath)}>
                {s.projects.openFile}
              </Button>
            </div>
            <ProgressBar value={f.total > 0 ? (f.done / f.total) * 100 : 0} label={s.projects.progress(f.done, f.total)} />
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {f.groups.map((g, gi) => (
                <li key={`${g.title ?? ""}-${gi}`} className="flex flex-col gap-1">
                  <span className="flex items-center gap-2 text-small font-medium text-text-2" style={{ paddingLeft: `${Math.max(0, g.level - 1) * 12}px` }}>
                    <span className="min-w-0 flex-1 truncate">{g.title ?? s.projects.noHeading}</span>
                    <span className="font-mono text-meta text-muted">
                      {g.done}/{g.total}
                    </span>
                  </span>
                  <ul className="m-0 flex list-none flex-col p-0">
                    {g.items
                      .filter((item) => item.state !== "done")
                      .slice(0, 3)
                      .map((item) => (
                        <li key={item.line}>
                          <button
                            type="button"
                            disabled={!inWorkspace}
                            onClick={() => openFile(f.relativePath, item.line)}
                            title={s.projects.openAtLine(item.line)}
                            className="flex w-full items-center gap-2 rounded-control bg-transparent px-1 py-0.5 text-left text-small text-text-3 hover:bg-surface-4 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-accent"
                          >
                            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${item.state === "inProgress" ? "bg-working" : "bg-track"}`} />
                            <span className="sr-only">{s.projects.itemStates[item.state]}</span>
                            <span className="min-w-0 flex-1 truncate">{item.text}</span>
                          </button>
                        </li>
                      ))}
                  </ul>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </section>
    </div>
  );
}

/** Last segment of a project root (`C:\src\app` → `app`): what the hub shows without an alias. */
function folderName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

function ProjectEditor({ project: p, customers, onChanged }: { project: ProjectDto; customers: Customer[]; onChanged: () => void }) {
  const s = useStrings();
  const [alias, setAlias] = useState(p.alias ?? "");
  const [customerId, setCustomerId] = useState(p.customerId === null ? "" : String(p.customerId));

  async function save() {
    try {
      if (alias.trim() !== (p.alias ?? "")) {
        await hubRequest("PUT", "/v1/projects/alias", { root: p.root, alias: alias.trim() === "" ? null : alias.trim() });
      }
      const nextCustomer = customerId === "" ? null : Number(customerId);
      if (nextCustomer !== p.customerId) {
        await hubRequest("PUT", "/v1/projects/customer", { root: p.root, customerId: nextCustomer });
      }
      useToastStore.getState().show(s.projects.saved);
      onChanged();
    } catch (e) {
      useToastStore.getState().show(asAppError(e).message);
    }
  }

  async function toggleHidden() {
    try {
      await hubRequest("PUT", "/v1/projects/hidden", { root: p.root, hidden: !p.hidden });
      onChanged();
    } catch (e) {
      useToastStore.getState().show(asAppError(e).message);
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-title font-semibold text-text">{p.name}</h2>
        <span className="truncate font-mono text-meta text-muted" title={p.root}>
          {p.root}
        </span>
        {p.git && <GitSummary git={p.git} />}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={s.projects.alias} hint={s.projects.aliasHint}>
          {(ids) => <TextInput {...ids} value={alias} onChange={setAlias} placeholder={folderName(p.root)} />}
        </Field>
        <Field label={s.projects.customer}>
          {(ids) => (
            <Select<string>
              {...ids}
              value={customerId}
              onChange={setCustomerId}
              options={[{ value: "", label: s.projects.noCustomer }, ...customers.filter((c) => !c.archived || c.id === p.customerId).map((c) => ({ value: String(c.id), label: c.name }))]}
            />
          )}
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => void save()}>
          {s.projects.save}
        </Button>
        <Button variant="ghost" onClick={() => void toggleHidden()}>
          {p.hidden ? s.projects.unhide : s.projects.hide}
        </Button>
      </div>
    </Card>
  );
}
