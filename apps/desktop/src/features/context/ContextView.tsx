/**
 * 0.9 "Agent context" tab (D-076): read-only view of what an agent picks up in the workspace –
 * instruction files (load order, `@` imports indented), on-demand files, rules, skills and MCP
 * servers (secret key names only), with a rough token estimate. A file inside the workspace opens
 * in the normal viewer; one outside (home, managed) is previewed read-only next to the list.
 */
import { useEffect, useMemo, type ReactNode } from "react";
import { useStrings } from "../../app/i18n";
import { Button } from "../../app/ui";
import type { ContextReport, ContextSkill, McpServer } from "../../lib/ipc";
import { previewKey, reportKey, useContextStore, type PreviewTarget } from "../../stores/contextStore";
import { useViewerStore } from "../../stores/viewerStore";
import { AssistantMarkdown } from "../assistant/AssistantMarkdown";
import { Notice, Select } from "../settings/controls";
import { defaultAgentFor } from "./contextActions";
import { contextSections, formatBytes, formatTokenEstimate, isEmptyReport, pickerAgents, type FileRow } from "./contextLogic";

const ACTION_BUTTON = "h-7 whitespace-nowrap px-2 text-small";
const SUBHEAD = "m-0 text-label font-semibold uppercase tracking-[0.08em] text-faint";
const CHIP = "shrink-0 rounded-badge bg-surface-5 px-1.5 text-label text-text-3";
const ROW_BUTTON =
  "flex w-full cursor-pointer flex-col gap-1 rounded-control px-2 py-1.5 text-left hover:bg-surface-4 focus-visible:outline-2 focus-visible:outline-accent";
const INDENT = ["", "pl-5", "pl-8", "pl-11", "pl-14"];
const SIZE = "whitespace-nowrap font-mono text-label text-muted";

export function ContextView({ workspaceId, agent: tabAgent }: { workspaceId: string; agent?: string }) {
  const s = useStrings();
  const t = s.agentContext;
  const agents = useContextStore((st) => st.agents);
  // Entry points always name the agent; a tab without one shows the workspace's default.
  const agent = tabAgent ?? defaultAgentFor(workspaceId);
  const entry = useContextStore((st) => st.reports[reportKey(workspaceId, agent)]);
  const openPreview = useContextStore((st) => st.preview[workspaceId] ?? null);
  const preview = openPreview && openPreview.agent === agent ? openPreview : null;

  useEffect(() => {
    void useContextStore.getState().loadAgents();
  }, []);
  useEffect(() => useContextStore.getState().ensure(workspaceId, agent), [workspaceId, agent]);

  const report = entry?.report ?? null;
  const loading = !entry || entry.status === "loading";
  const options = agents ? pickerAgents(agents, agent) : null;
  const agentName = agents?.find((a) => a.id === agent)?.displayName ?? agent;

  const setAgent = (next: string) => {
    useViewerStore.getState().openContext(workspaceId, next);
  };

  let body;
  if (!report) {
    body =
      entry?.status === "error" ? (
        <Notice tone="error">{`${t.loadFailed} ${entry.error ? s.errors.forCode(entry.error.code) : ""}`.trim()}</Notice>
      ) : (
        <p className="m-0 text-body text-muted">{t.loading}</p>
      );
  } else if (!report.supported) {
    body = (
      <div className="flex max-w-[64ch] flex-col gap-2 py-2" data-testid="context-unsupported">
        <p className="m-0 font-medium text-text-2">{t.unsupported.title(agentName)}</p>
        <p className="m-0 text-small text-muted">{t.unsupported.body}</p>
      </div>
    );
  } else if (isEmptyReport(report)) {
    body = (
      <p className="m-0 text-body text-muted" data-testid="context-empty">
        {t.empty}
      </p>
    );
  } else {
    body = <ReportBody workspaceId={workspaceId} report={report} selected={preview?.path ?? null} />;
  }

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-bg" data-testid="context-view" data-agent={agent}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-subtle px-4 py-2.5">
        <div className="flex min-w-0 flex-col">
          <h2 className="m-0 text-title font-semibold text-text">{t.title}</h2>
          {report && (
            <span className="truncate font-mono text-meta text-muted" title={report.root}>
              {report.root}
            </span>
          )}
        </div>
        <div className="flex-1" />
        {options && (
          <div className="w-48">
            <Select ariaLabel={t.agentLabel} value={agent} onChange={setAgent} options={options.map((a) => ({ value: a.id, label: a.displayName }))} />
          </div>
        )}
        <Button variant="secondary" className={ACTION_BUTTON} disabled={loading} onClick={() => void useContextStore.getState().refresh(workspaceId, agent)}>
          {loading ? t.loading : t.refresh}
        </Button>
      </header>
      {report?.supported && !isEmptyReport(report) && <Totals report={report} />}
      <div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
        <div className={`flex min-h-0 flex-col gap-4 overflow-auto px-4 py-3 ${preview ? "flex-1 @3xl:basis-1/2" : "flex-1"}`}>
          {report && entry?.status === "error" && entry.error && <Notice tone="error">{`${t.loadFailed} ${s.errors.forCode(entry.error.code)}`}</Notice>}
          {body}
        </div>
        {preview && <PreviewPane workspaceId={workspaceId} target={preview} />}
      </div>
    </div>
  );
}

function Totals({ report }: { report: ContextReport }) {
  const t = useStrings().agentContext;
  const { totals } = report;
  return (
    <div className="flex flex-col gap-1 border-b border-border-subtle bg-surface-1 px-4 py-2" data-testid="context-totals">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-mono text-body font-semibold text-text">{t.alwaysTotal(formatTokenEstimate(totals.alwaysTokens))}</span>
        <span className="font-mono text-small text-text-2">{t.onDemandTotal(formatTokenEstimate(totals.onDemandTokens))}</span>
        <span className="font-mono text-small text-text-2">{t.skillsTotal(formatTokenEstimate(totals.skillTokens))}</span>
      </div>
      <p className="m-0 text-meta text-muted">
        {t.estimateNote}
        {report.maxBytes !== null && ` ${t.maxBytes(formatBytes(report.maxBytes))}`}
      </p>
    </div>
  );
}

function ReportBody({ workspaceId, report, selected }: { workspaceId: string; report: ContextReport; selected: string | null }) {
  const t = useStrings().agentContext;
  const sections = useMemo(() => contextSections(report.files), [report.files]);
  const open = (item: { path: string; display: string; rel: string | null }) => {
    if (item.rel !== null) useViewerStore.getState().openFile(workspaceId, item.rel, { pinned: true });
    else useContextStore.getState().openPreview(workspaceId, { agent: report.agent, path: item.path, display: item.display });
  };
  const maxBytes = report.maxBytes;
  return (
    <>
      <Section id="always" title={t.sections.always} hint={t.hints.always} count={sections.always.length}>
        {sections.always.map((row) => (
          <FileItem key={row.file.path} row={row} maxBytes={maxBytes} selected={selected === row.file.path} onOpen={() => open(row.file)} />
        ))}
      </Section>
      <Section id="onDemand" title={t.sections.onDemand} hint={t.hints.onDemand} count={sections.onDemand.length}>
        {sections.onDemand.map((row) => (
          <FileItem key={row.file.path} row={row} maxBytes={maxBytes} selected={selected === row.file.path} onOpen={() => open(row.file)} />
        ))}
      </Section>
      {sections.rules.length > 0 && (
        <Section id="rules" title={t.sections.rules} count={sections.rules.length}>
          {sections.rules.map((row) => (
            <FileItem key={row.file.path} row={row} maxBytes={maxBytes} selected={selected === row.file.path} onOpen={() => open(row.file)} />
          ))}
        </Section>
      )}
      <Section id="skills" title={t.sections.skills} hint={t.hints.skills} count={report.skills.length}>
        {report.skills.map((skill) => (
          <SkillItem key={skill.path} skill={skill} selected={selected === skill.path} onOpen={() => open(skill)} />
        ))}
      </Section>
      <Section id="mcp" title={t.sections.mcp} count={report.mcp.length}>
        {report.mcp.map((server) => (
          <McpItem key={`${server.source}:${server.name}`} server={server} />
        ))}
      </Section>
      {report.sources.length > 0 && <Sources report={report} />}
    </>
  );
}

function Section({ id, title, hint, count, children }: { id: string; title: string; hint?: string; count: number; children: ReactNode }) {
  const t = useStrings().agentContext;
  return (
    <section className="flex flex-col gap-1.5" data-testid={`context-section-${id}`}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className={SUBHEAD}>{title}</h3>
        <span className="font-mono text-label text-faint">{count}</span>
        {hint && <span className="text-meta text-muted">{hint}</span>}
      </div>
      {count === 0 ? <p className="m-0 px-2 text-small text-muted">{t.none}</p> : <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{children}</ul>}
    </section>
  );
}

function ScopeChip({ scope }: { scope: "managed" | "user" | "project" | "local" }) {
  const t = useStrings().agentContext;
  return <span className={CHIP}>{t.scope[scope]}</span>;
}

function FileItem({ row, maxBytes, selected, onOpen }: { row: FileRow; maxBytes: number | null; selected: boolean; onOpen: () => void }) {
  const t = useStrings().agentContext;
  const { file, depth } = row;
  return (
    <li data-testid="context-file" data-path={file.display}>
      <button
        type="button"
        aria-label={file.rel !== null ? t.open(file.display) : t.previewOf(file.display)}
        title={file.importedBy ? t.importedBy(file.importedBy) : file.path}
        onClick={onOpen}
        className={`${ROW_BUTTON} ${INDENT[depth] ?? ""} ${selected ? "bg-surface-4" : ""}`}
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          {depth > 0 && (
            <span aria-hidden className="text-faint">
              ↳
            </span>
          )}
          <span className={`min-w-0 break-all font-mono text-small ${file.rel !== null ? "text-accent" : "text-text"}`}>{file.display}</span>
        </span>
        <span className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ${depth > 0 ? "pl-4" : ""}`}>
          <ScopeChip scope={file.scope} />
          {file.kind === "rule" && file.loaded === "onDemand" && <span className={CHIP}>{t.onDemandChip}</span>}
          {file.overLimit && (
            <span className="shrink-0 rounded-badge bg-working-bg px-1.5 text-label text-working-ink" title={maxBytes !== null ? t.overLimitTitle(formatBytes(maxBytes)) : undefined}>
              {t.overLimit}
            </span>
          )}
          {file.error && (
            <span className="shrink-0 rounded-badge bg-blocked-bg px-1.5 text-label text-blocked-ink" title={file.error}>
              {t.unreadable}
            </span>
          )}
          <span className={SIZE}>{`${formatBytes(file.bytes)} · ${t.tokens(formatTokenEstimate(file.tokens))}`}</span>
        </span>
      </button>
    </li>
  );
}

function SkillItem({ skill, selected, onOpen }: { skill: ContextSkill; selected: boolean; onOpen: () => void }) {
  const t = useStrings().agentContext;
  return (
    <li data-testid="context-skill" data-name={skill.name}>
      <button
        type="button"
        aria-label={skill.rel !== null ? t.open(skill.display) : t.previewOf(skill.display)}
        title={skill.path}
        onClick={onOpen}
        className={`${ROW_BUTTON} ${selected ? "bg-surface-4" : ""}`}
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-small font-medium text-text">{skill.name}</span>
          <ScopeChip scope={skill.scope} />
          <span className={SIZE}>{t.tokens(formatTokenEstimate(skill.tokens))}</span>
        </span>
        {skill.description && <span className="line-clamp-2 text-small text-text-2">{skill.description}</span>}
        <span className={`break-all font-mono text-label ${skill.rel !== null ? "text-accent" : "text-muted"}`}>{skill.display}</span>
      </button>
    </li>
  );
}

function McpItem({ server }: { server: McpServer }) {
  const t = useStrings().agentContext;
  const inactive = server.disabled || server.shadowedBy !== null;
  const target = server.command ? `${server.command}${server.argCount > 0 ? ` · ${t.mcp.args(server.argCount)}` : ""}` : server.url;
  return (
    <li className={`flex flex-col gap-0.5 rounded-control px-2 py-1.5 ${inactive ? "opacity-70" : ""}`} data-testid="context-mcp" data-name={server.name}>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`font-mono text-small font-medium ${inactive ? "text-muted line-through" : "text-text"}`}>{server.name}</span>
        <ScopeChip scope={server.scope} />
        <span className={CHIP}>{t.mcp.transport[server.transport]}</span>
        {server.secretKeys.length > 0 && (
          <span
            className="shrink-0 cursor-help rounded-badge bg-done-bg px-1.5 text-label text-done-ink"
            title={t.mcp.secretsTitle(server.secretKeys.join(", "))}
            data-testid="context-secrets"
          >
            {t.mcp.secrets(server.secretKeys.length)}
          </span>
        )}
        {server.disabled && <span className="shrink-0 rounded-badge bg-surface-5 px-1.5 text-label text-muted">{t.mcp.disabled}</span>}
        {server.shadowedBy && <span className="shrink-0 rounded-badge bg-working-bg px-1.5 text-label text-working-ink">{t.mcp.shadowed(server.shadowedBy)}</span>}
      </span>
      <span className="flex flex-wrap gap-x-2 text-label">
        {target && <span className="break-all font-mono text-text-3">{target}</span>}
        <span className="break-all text-muted">{t.mcp.source(server.source)}</span>
      </span>
    </li>
  );
}

function Sources({ report }: { report: ContextReport }) {
  const t = useStrings().agentContext;
  return (
    <section className="flex flex-col gap-1 border-t border-border-subtle pt-3" data-testid="context-sources">
      <h3 className={SUBHEAD}>{t.sources.title}</h3>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {report.sources.map((src) => (
          <li key={`${src.scope}:${src.path}`} className="flex flex-wrap items-baseline gap-x-2 text-label">
            <span className={`break-all font-mono ${src.exists ? "text-text-3" : "text-muted"}`} title={src.path}>
              {src.display}
            </span>
            <span className="text-muted">{t.scope[src.scope]}</span>
            <span className={src.error ? "text-blocked-ink" : "text-muted"}>
              {src.error ? t.sources.error(src.error) : src.exists ? t.sources.servers(src.serverCount) : t.sources.missing}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PreviewPane({ workspaceId, target }: { workspaceId: string; target: PreviewTarget }) {
  const s = useStrings();
  const t = s.agentContext;
  const entry = useContextStore((st) => st.previews[previewKey(workspaceId, target.agent, target.path)]);
  return (
    <aside
      className="flex min-h-0 flex-1 flex-col border-t border-border-subtle bg-surface-2 @3xl:basis-1/2 @3xl:border-l @3xl:border-t-0"
      aria-label={t.previewOf(target.display)}
      data-testid="context-preview"
    >
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-1.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-small text-text" title={target.path}>
            {target.display}
          </span>
          <span className="text-label text-muted">{t.preview.readOnly}</span>
        </div>
        <button
          type="button"
          aria-label={t.preview.close}
          title={t.preview.close}
          onClick={() => useContextStore.getState().closePreview(workspaceId)}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control text-muted hover:bg-surface-5 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {!entry || entry.status === "loading" ? (
          <p className="m-0 text-small text-muted">{t.loading}</p>
        ) : entry.status === "error" ? (
          <Notice tone="error">{`${t.preview.failed} ${entry.error ? s.errors.forCode(entry.error.code) : ""}`.trim()}</Notice>
        ) : (
          <>
            {entry.truncated && (
              <div className="mb-3">
                <Notice tone="warning">{t.preview.truncated}</Notice>
              </div>
            )}
            <AssistantMarkdown text={entry.text} />
          </>
        )}
      </div>
    </aside>
  );
}
