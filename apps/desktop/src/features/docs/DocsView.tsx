/**
 * 0.7 Docs tab (D-074): the workspace's docs check – which docs name paths that no longer exist
 * and which cover code that changed since their baseline. Each row expands to the missing paths
 * (click opens the doc at that line), "why stale" (commits, changed files → diff from the
 * baseline) and the actions Open doc / Mark reviewed / Update with agent… (D-066 composer flow:
 * nothing is sent until the user sends).
 */
import { useEffect, useMemo, useState } from "react";
import { useStrings } from "../../app/i18n";
import { ConfirmModal } from "../../app/ConfirmModal";
import { Button, Segmented, formatIsoDate } from "../../app/ui";
import { clipboardWriteText, toAppError, type DocDoc, type DocLink, type DocsReport } from "../../lib/ipc";
import { DEFAULT_DOCS_VIEW, useDocsStore } from "../../stores/docsStore";
import { useToastStore } from "../../stores/toastStore";
import { useViewerStore } from "../../stores/viewerStore";
import { navigateToAgent } from "../agents/navigate";
import { useComposerInbox } from "../composer/composerInbox";
import { Notice } from "../settings/controls";
import { useAgentTargets, type AgentTarget } from "../review/agentTargets";
import { ContextMenu, type ContextMenuState } from "../workspaces/ContextMenu";
import { DOCS_TOML_EXAMPLE, buildDocsPrompt, filterDocs, findingCounts, isConfigLink, shortId, type DocsFilter } from "./docsLogic";

const ACTION_BUTTON = "h-7 whitespace-nowrap px-2 text-small";
const SUBHEAD = "m-0 text-label font-semibold uppercase tracking-[0.08em] text-faint";
const LINK_BUTTON = "cursor-pointer rounded-control text-small hover:underline focus-visible:outline-2 focus-visible:outline-accent";

export function DocsView({ workspaceId }: { workspaceId: string }) {
  const s = useStrings();
  const t = s.docs;
  const entry = useDocsStore((st) => st.byWorkspace[workspaceId]);
  const view = useDocsStore((st) => st.view[workspaceId] ?? DEFAULT_DOCS_VIEW);
  const { filter, expanded } = view;
  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  useEffect(() => useDocsStore.getState().watch(workspaceId), [workspaceId]);

  const report = entry?.report ?? null;
  const loading = entry?.status === "loading" || !entry;
  const counts = useMemo(() => findingCounts(report?.docs ?? []), [report]);
  const rows = useMemo(() => filterDocs(report?.docs ?? [], filter), [report, filter]);

  const setFilter = (next: DocsFilter) => useDocsStore.getState().setFilter(workspaceId, next);
  const toggle = (path: string) => useDocsStore.getState().toggleExpanded(workspaceId, path);

  const markReviewed = async (path: string) => {
    setConfirmPath(null);
    const err = await useDocsStore.getState().markReviewed(workspaceId, path);
    useToastStore.getState().show(err ? s.errors.forCode(err.code) : t.markedToast(path));
  };

  let body;
  if (!report) {
    body = entry?.status === "error" ? (
      <Notice tone="error">{`${t.loadFailed} ${entry.error ? s.errors.forCode(entry.error.code) : ""}`.trim()}</Notice>
    ) : (
      <p className="m-0 text-body text-muted">{t.checking}</p>
    );
  } else if (report.docs.length === 0) {
    body = <EmptyDocs />;
  } else if (rows.length === 0) {
    body = (
      <p className="m-0 text-body text-muted" data-testid="docs-none">
        {filter === "missing" ? t.noneMissing : filter === "stale" ? t.noneStale : t.allGood(report.docs.length)}
      </p>
    );
  } else {
    body = (
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map((doc) => (
          <DocRow
            key={doc.path}
            workspaceId={workspaceId}
            report={report}
            doc={doc}
            open={expanded.includes(doc.path)}
            onToggle={() => toggle(doc.path)}
            onMarkReviewed={() => setConfirmPath(doc.path)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-testid="docs-view">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-subtle px-4 py-2.5">
        <div className="flex min-w-0 flex-col">
          <h2 className="m-0 text-title font-semibold text-text">{t.title}</h2>
          {report && (
            <span className="text-meta text-muted" data-testid="docs-summary">
              {t.summary(report.summary.docs, counts.missing, counts.stale)}
            </span>
          )}
        </div>
        <div className="flex-1" />
        {report && report.docs.length > 0 && (
          <Segmented<DocsFilter>
            ariaLabel={t.filter.label}
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: t.filter.all(counts.all) },
              { value: "missing", label: t.filter.missing(counts.missing) },
              { value: "stale", label: t.filter.stale(counts.stale) },
            ]}
          />
        )}
        <Button variant="secondary" className={ACTION_BUTTON} disabled={loading} onClick={() => void useDocsStore.getState().refresh(workspaceId)}>
          {loading ? t.checking : t.checkAgain}
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3">
        {report && !report.gitAvailable && <Notice>{t.noGit}</Notice>}
        {report?.configError && <Notice tone="warning">{t.configError(report.configError.line, report.configError.message)}</Notice>}
        {report?.truncated && <Notice tone="warning">{t.truncated}</Notice>}
        {report && entry?.status === "error" && entry.error && <Notice tone="error">{`${t.loadFailed} ${s.errors.forCode(entry.error.code)}`}</Notice>}
        {body}
      </div>
      {confirmPath && report && (
        <ConfirmModal
          title={t.confirm.title(confirmPath)}
          body={t.confirm.body(shortId(report.head ?? ""))}
          confirmLabel={t.confirm.confirm}
          onCancel={() => setConfirmPath(null)}
          onConfirm={() => void markReviewed(confirmPath)}
        />
      )}
    </div>
  );
}

interface DocRowProps {
  workspaceId: string;
  report: DocsReport;
  doc: DocDoc;
  open: boolean;
  onToggle: () => void;
  onMarkReviewed: () => void;
}

function DocRow({ workspaceId, report, doc, open, onToggle, onMarkReviewed }: DocRowProps) {
  const s = useStrings();
  const t = s.docs;
  const canMark = report.gitAvailable && report.head !== null;
  const openFile = (rel: string, line?: number) => useViewerStore.getState().openFile(workspaceId, rel, { pinned: true, ...(line ? { line } : {}) });
  return (
    <li className="overflow-hidden rounded-card border border-border-subtle bg-surface-2" data-testid="docs-row" data-doc={doc.path}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={t.expand(doc.path)}
        onClick={onToggle}
        className="flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left hover:bg-surface-4 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span aria-hidden className="w-3 shrink-0 text-muted">
          {open ? "▾" : "▸"}
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-all font-mono text-small text-text">{doc.path}</span>
          {doc.agentFile && <span className="shrink-0 rounded-badge bg-done-bg px-1.5 text-label text-done-ink">{t.agentFile}</span>}
          <span className="ml-auto flex shrink-0 flex-wrap gap-1">
            {doc.missing.length > 0 && (
              <span className="rounded-badge bg-blocked-bg px-1.5 text-label text-blocked-ink">{t.missingCount(doc.missing.length)}</span>
            )}
            {doc.stale && <span className="rounded-badge bg-working-bg px-1.5 text-label text-working-ink">{t.staleCommits(doc.stale.commitCount)}</span>}
          </span>
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-border-subtle px-3 py-3 sm:pl-8">
          {doc.missing.length > 0 && (
            <section className="flex flex-col gap-1.5" data-testid="docs-missing">
              <h3 className={SUBHEAD}>{t.missingTitle}</h3>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {doc.missing.map((link) => (
                  <MissingLink key={`${link.source}:${link.target}`} link={link} doc={doc} configPath={report.configPath} onOpen={openFile} />
                ))}
              </ul>
            </section>
          )}
          {doc.stale && <WhyStale workspaceId={workspaceId} doc={doc} />}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" className={ACTION_BUTTON} onClick={() => openFile(doc.path)}>
              {t.actions.openDoc}
            </Button>
            <Button
              variant="secondary"
              className={ACTION_BUTTON}
              disabled={!canMark}
              title={canMark ? undefined : t.actions.noCommit}
              onClick={onMarkReviewed}
            >
              {t.actions.markReviewed}
            </Button>
            <UpdateWithAgentButton workspaceId={workspaceId} doc={doc} configPath={report.configPath} />
          </div>
        </div>
      )}
    </li>
  );
}

function MissingLink({ link, doc, configPath, onOpen }: { link: DocLink; doc: DocDoc; configPath: string | null; onOpen: (rel: string, line?: number) => void }) {
  const t = useStrings().docs;
  const config = isConfigLink(link);
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-small">
      <span className="break-all font-mono text-blocked-ink">{link.target}</span>
      {config ? (
        configPath ? (
          <button type="button" className={`${LINK_BUTTON} text-muted hover:text-accent`} aria-label={t.openConfig} onClick={() => onOpen(configPath)}>
            {t.inConfig}
          </button>
        ) : (
          <span className="text-muted">{t.inConfig}</span>
        )
      ) : (
        <>
          <button type="button" className={`${LINK_BUTTON} font-mono text-muted hover:text-accent`} aria-label={t.openAt(doc.path, link.line)} onClick={() => onOpen(doc.path, link.line)}>
            {`${doc.path}:${link.line}`}
          </button>
          <span className="text-faint">{t.source[link.source]}</span>
        </>
      )}
    </li>
  );
}

function WhyStale({ workspaceId, doc }: { workspaceId: string; doc: DocDoc }) {
  const t = useStrings().docs;
  const st = doc.stale!;
  const since = shortId(st.baseline);
  const more = st.commitCount - st.commits.length;
  return (
    <section className="flex flex-col gap-1.5" data-testid="docs-stale">
      <h3 className={SUBHEAD}>{t.whyStale}</h3>
      <p className="m-0 text-small text-text-2">{t.staleReason(st.commitCount, since, st.baselineKind === "reviewed")}</p>
      {st.reviewedMissing && <p className="m-0 text-small text-working-ink">{t.reviewedMissing}</p>}
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {st.commits.map((c) => (
          <li key={c.id} className="flex min-w-0 items-baseline gap-2 text-small">
            <span className="shrink-0 font-mono text-muted">{shortId(c.id)}</span>
            <span className="min-w-0 truncate text-text-2" title={c.subject}>
              {c.subject}
            </span>
            <span className="shrink-0 font-mono text-label text-faint">{formatIsoDate(c.date.slice(0, 10))}</span>
          </li>
        ))}
        {more > 0 && <li className="text-small text-muted">{t.moreCommits(more)}</li>}
      </ul>
      {st.files.length > 0 && (
        <>
          <h3 className={`${SUBHEAD} mt-1`}>{t.changedFiles}</h3>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {st.files.map((f) => (
              <li key={f.path} className="flex flex-wrap items-baseline gap-2">
                <button
                  type="button"
                  className={`${LINK_BUTTON} break-all text-left font-mono text-accent`}
                  aria-label={t.showDiff(f.path, since)}
                  onClick={() => useViewerStore.getState().openDiff(workspaceId, f.path, { rev: st.baseline })}
                >
                  {f.path}
                </button>
                <span className="text-label text-muted">{t.fileCommits(f.commits)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function UpdateWithAgentButton({ workspaceId, doc, configPath }: { workspaceId: string; doc: DocDoc; configPath: string | null }) {
  const t = useStrings().docs;
  const targets = useAgentTargets(workspaceId);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const send = (target: AgentTarget) => {
    // Navigate first: it focuses the terminal on the next frame, the composer focuses itself after.
    navigateToAgent(target.agent);
    useComposerInbox.getState().deliver(target.agent.paneId, buildDocsPrompt(doc, configPath));
    useToastStore.getState().show(t.sentTo(target.label));
  };

  return (
    <>
      <Button
        variant="secondary"
        className={ACTION_BUTTON}
        disabled={targets.length === 0}
        title={targets.length === 0 ? t.actions.noAgent : undefined}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setMenu({ x: box.left, y: box.bottom + 4, items: targets.map((target) => ({ label: target.label, onClick: () => send(target) })) });
        }}
      >
        {t.actions.updateWithAgent}
      </Button>
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

function EmptyDocs() {
  const s = useStrings();
  const t = s.docs.empty;
  const copy = () => {
    void clipboardWriteText(DOCS_TOML_EXAMPLE)
      .then(() => useToastStore.getState().show(t.copied))
      .catch((e) => useToastStore.getState().show(s.errors.forCode(toAppError(e).code)));
  };
  return (
    <div className="flex max-w-[64ch] flex-col gap-3 py-2" data-testid="docs-empty">
      <p className="m-0 font-medium text-text-2">{t.title}</p>
      <p className="m-0 text-small text-muted">{t.body}</p>
      <pre className="m-0 overflow-auto rounded-card border border-border-subtle bg-terminal px-3 py-2 font-mono text-small text-text-2">{DOCS_TOML_EXAMPLE}</pre>
      <div>
        <Button variant="secondary" className={ACTION_BUTTON} onClick={copy}>
          {t.copy}
        </Button>
      </div>
    </div>
  );
}
