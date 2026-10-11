/**
 * Reports (M2, CCC spec §12.5 / §18): daily summary, wait metrics, cost by customer / project /
 * agent / model with CSV / Excel export. Summaries are shown as stored; generating them needs
 * the assistant (hub reports `generationAvailable: false` until then).
 */
import { useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { save } from "@tauri-apps/plugin-dialog";
import "../viewer/renderers/markdownPreview.css";
import { currentLanguage, formatNumber, formatPercent, useStrings } from "../../app/i18n";
import {
  AgentAvatar,
  Button,
  Card,
  EmptyState,
  Page,
  PageHeader,
  Segmented,
  StatTile,
  agentDisplayName,
  formatClock,
  formatCost,
  formatDuration,
  formatIsoDate,
  formatTokenCount,
  toIsoDate,
  useHubQuery,
} from "../../app/ui";
import type {
  CostGrouping,
  CostReport,
  DailySummary,
  DailySummaryDetail,
  DailySummaryStatus,
  WaitReport,
} from "../../lib/hubTypes";
import { hubExport, toAppError } from "../../lib/ipc";
import { useToastStore } from "../../stores/toastStore";
import { BarChart } from "../usage/BarChart";
import { costPath, defaultCostRange, exportFileName, hourLabel, type ExportFormat } from "./reportsLogic";

type Tab = "daily" | "waits" | "cost";

export function ReportsPage() {
  const s = useStrings();
  const [tab, setTab] = useState<Tab>("daily");
  return (
    <Page>
      <PageHeader
        title={s.nav.reports}
        subtitle={s.reports.subtitle}
        actions={
          <Segmented
            ariaLabel={s.reports.tabsLabel}
            value={tab}
            onChange={setTab}
            options={[
              { value: "daily", label: s.reports.tabs.daily },
              { value: "waits", label: s.reports.tabs.waits },
              { value: "cost", label: s.reports.tabs.cost },
            ]}
          />
        }
      />
      {tab === "daily" && <DailyTab />}
      {tab === "waits" && <WaitsTab />}
      {tab === "cost" && <CostTab />}
    </Page>
  );
}

function Unavailable() {
  const s = useStrings();
  return (
    <Card>
      <EmptyState title={s.ui.hubUnavailableTitle} body={s.ui.hubUnavailableBody} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Daily summary
// ---------------------------------------------------------------------------

function DailyTab() {
  const s = useStrings();
  const list = useHubQuery<DailySummary[]>("/v1/reports/daily-summaries?limit=30");
  const status = useHubQuery<DailySummaryStatus>("/v1/reports/daily-summaries/status");
  const [selected, setSelected] = useState<string | null>(null);
  const date = selected ?? list.data?.[0]?.date ?? toIsoDate(new Date());
  const detail = useHubQuery<DailySummaryDetail>(list.loading ? null : `/v1/reports/daily-summaries/${date}`);

  if (list.unavailable) return <Unavailable />;
  const st = status.data;
  const note =
    st && !st.generationAvailable
      ? st.reason === "clientRequired"
        ? s.reports.daily.clientRequired
        : s.reports.daily.unavailable(st.reason ?? "—")
      : null;

  return (
    <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[240px_1fr]">
      <Card title={s.reports.daily.list} labelledBy="reports-daily-list" bodyClassName="p-1.5">
        {list.data && list.data.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {list.data.map((d) => (
              <li key={d.date}>
                <button
                  type="button"
                  aria-current={d.date === date ? "true" : undefined}
                  onClick={() => setSelected(d.date)}
                  className={`w-full rounded-control px-2.5 py-1.5 text-left text-body ${
                    d.date === date ? "bg-surface-selected text-text" : "text-text-2 hover:bg-surface-4"
                  }`}
                >
                  {formatIsoDate(d.date, { weekday: "short", day: "numeric", month: "short" })}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={list.loading ? s.ui.loading : s.reports.daily.empty} />
        )}
      </Card>
      <div className="flex min-w-0 flex-col gap-3.5">
        {note && <p className="m-0 rounded-card border border-border-subtle bg-surface-2 px-4 py-3 text-body text-text-3">{note}</p>}
        <DayDetail detail={detail.data} date={date} />
      </div>
    </div>
  );
}

function DayDetail({ detail, date }: { detail: DailySummaryDetail | null; date: string }) {
  const s = useStrings();
  const input = detail?.input;
  const summary = detail?.summary ?? null;
  return (
    <>
      <Card title={`${s.reports.daily.metrics} · ${formatIsoDate(date, { weekday: "long", day: "numeric", month: "long" })}`} labelledBy="reports-day">
        {input && !input.hasActivity ? (
          <EmptyState title={s.reports.daily.noActivity} />
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Metric label={s.reports.daily.activeTime} value={input ? formatDuration(input.activeMinutes * 60) : "—"} />
            <Metric label={s.reports.daily.sessions} value={input ? formatNumber(input.sessions) : "—"} />
            <Metric label={s.reports.daily.tokens} value={formatTokenCount(input?.tokens ?? null)} />
            <Metric label={s.reports.daily.cost} value={formatCost(input?.costUsd ?? null)} />
            <Metric label={s.reports.daily.waiting} value={input ? formatDuration(input.waitMinutes * 60) : "—"} />
          </div>
        )}
      </Card>
      <Card labelledBy="reports-summary">
        {summary ? (
          <div className="flex flex-col gap-2">
            <div className="md-preview text-ui">
              <Markdown remarkPlugins={[remarkGfm]}>{summary.markdown}</Markdown>
            </div>
            <span className="text-meta text-muted">
              {s.reports.daily.generatedWith(summary.model ?? "—", formatClock(summary.generatedAt))}
            </span>
          </div>
        ) : (
          <EmptyState title={s.reports.daily.noSummary} />
        )}
      </Card>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-small text-text-3">{label}</span>
      <span className="font-mono text-[18px] font-semibold text-text">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Waits
// ---------------------------------------------------------------------------

function WaitsTab() {
  const s = useStrings();
  const q = useHubQuery<WaitReport>("/v1/reports/waits");
  if (q.unavailable) return <Unavailable />;
  const r = q.data;
  if (!r) return <Card><EmptyState title={q.loading ? s.ui.loading : (q.error ?? s.ui.loadFailed)} /></Card>;
  if (r.count === 0) return <Card><EmptyState title={s.reports.waits.empty} body={s.reports.waits.range} /></Card>;

  const hours = r.byHourSeconds.map((sec, h) => ({
    key: String(h),
    label: hourLabel(h),
    value: sec,
    display: formatDuration(sec),
  }));
  return (
    <div className="flex flex-col gap-3.5">
      <p className="m-0 text-small text-muted">{s.reports.waits.range}</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={s.reports.waits.total}
          value={formatDuration(r.totalSeconds)}
          detail={`${s.reports.waits.permission} ${formatDuration(r.permissionSeconds)} · ${s.reports.waits.input} ${formatDuration(r.inputSeconds)}`}
        />
        <StatTile label={s.reports.waits.count} value={formatNumber(r.count)} detail={`${s.reports.waits.quiet}: ${formatDuration(r.duringQuietHoursSeconds)}`} />
        <StatTile label={s.reports.waits.average} value={formatDuration(r.averageSeconds)} detail={`${s.reports.waits.median} ${formatDuration(r.medianSeconds)}`} />
        <StatTile label={s.reports.waits.topTool} value={r.topPermissionTool ?? "—"} />
      </div>
      <Card title={s.reports.waits.byHour} labelledBy="waits-hours">
        <BarChart data={hours} ariaLabel={s.reports.waits.byHour} formatAxis={(v) => formatDuration(v)} labelEvery={3} />
      </Card>
      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2">
        <Card title={s.reports.waits.byProject} labelledBy="waits-projects" bodyClassName="p-0">
          <SimpleTable
            head={[s.reports.waits.columns.project, s.reports.waits.columns.duration]}
            rows={r.byProject.map((p) => [p.projectName, <span key="d" className="font-mono">{formatDuration(p.seconds)}</span>])}
          />
        </Card>
        <Card title={s.reports.waits.longest} labelledBy="waits-longest" bodyClassName="p-0">
          <SimpleTable
            head={[s.reports.waits.columns.project, s.reports.waits.columns.kind, s.reports.waits.columns.started, s.reports.waits.columns.duration]}
            rows={r.longestSpans.slice(0, 10).map((w) => [
              w.projectName,
              w.kind === "permission" ? `${s.reports.waits.permission}${w.tool ? ` · ${w.tool}` : ""}` : s.reports.waits.input,
              <span key="t" className="font-mono">{formatClock(w.start)}</span>,
              <span key="d" className="font-mono">
                {formatDuration(w.seconds)}
                {w.isOpen ? ` (${s.reports.waits.open})` : ""}
              </span>,
            ])}
          />
        </Card>
      </div>
    </div>
  );
}

function SimpleTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <table className="w-full border-collapse text-body">
      <thead>
        <tr className="text-left text-label uppercase tracking-[0.08em] text-faint">
          {head.map((h, i) => (
            <th key={h} className={`py-2 font-semibold ${i === 0 ? "px-4" : "px-2"} ${i === head.length - 1 ? "pr-4 text-right" : ""}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, r) => (
          <tr key={r} className="border-t border-border-subtle">
            {cells.map((c, i) => (
              <td key={i} className={`py-2 text-text-2 ${i === 0 ? "px-4 text-text" : "px-2"} ${i === cells.length - 1 ? "pr-4 text-right" : ""}`}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

function CostTab() {
  const s = useStrings();
  const initial = defaultCostRange();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [groupBy, setGroupBy] = useState<CostGrouping>("project");
  const valid = from !== "" && to !== "" && from <= to;
  const q = useHubQuery<CostReport>(valid ? costPath(from, to, groupBy) : null);

  async function exportAs(format: ExportFormat) {
    try {
      const dest = await save({
        title: s.reports.cost.saveTitle,
        defaultPath: exportFileName(from, to, format),
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!dest) return;
      await hubExport(costPath(from, to, groupBy, format, currentLanguage()), dest);
      useToastStore.getState().show(s.reports.cost.exported(dest));
    } catch (e) {
      useToastStore.getState().show(`${s.reports.cost.exportFailed}: ${toAppError(e).message}`);
    }
  }

  if (q.unavailable) return <Unavailable />;
  const r = q.data;
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-end gap-3">
        <DateField label={s.reports.cost.from} value={from} onChange={setFrom} />
        <DateField label={s.reports.cost.to} value={to} onChange={setTo} />
        <div className="flex flex-col gap-1">
          <span className="text-label font-semibold uppercase tracking-[0.08em] text-faint">{s.reports.cost.groupBy}</span>
          <Segmented
            ariaLabel={s.reports.cost.groupBy}
            value={groupBy}
            onChange={setGroupBy}
            options={(["customer", "project", "agent", "model"] as const).map((g) => ({ value: g, label: s.reports.cost.groups[g] }))}
          />
        </div>
        <div className="flex-1" />
        <Button disabled={!valid} onClick={() => void exportAs("csv")}>
          {s.reports.cost.exportCsv}
        </Button>
        <Button disabled={!valid} onClick={() => void exportAs("xlsx")}>
          {s.reports.cost.exportXlsx}
        </Button>
      </div>
      <Card labelledBy="reports-cost" bodyClassName="p-0">
        {!r ? (
          <EmptyState title={q.loading ? s.ui.loading : (q.error ?? s.ui.loadFailed)} />
        ) : r.rows.length === 0 ? (
          <EmptyState title={s.reports.cost.empty} />
        ) : (
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="text-left text-label uppercase tracking-[0.08em] text-faint">
                <th className="px-4 py-2 font-semibold">{s.reports.cost.groups[groupBy]}</th>
                <th className="px-2 py-2 font-semibold">{s.reports.cost.columns.projects}</th>
                <th className="px-2 py-2 text-right font-semibold">{s.reports.cost.columns.sessions}</th>
                <th className="px-2 py-2 text-right font-semibold">{s.reports.cost.columns.tokens}</th>
                <th className="px-2 py-2 text-right font-semibold">{s.reports.cost.columns.cost}</th>
                <th className="px-4 py-2 text-right font-semibold">{s.reports.cost.columns.share}</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((row) => (
                <tr key={row.key} className="border-t border-border-subtle">
                  <td className="max-w-0 px-4 py-2">
                    <span className="flex items-center gap-2">
                      {groupBy === "agent" && <AgentAvatar agent={row.key} size={20} />}
                      <span className={`truncate ${row.kind === "normal" ? "text-text" : "text-muted"}`}>
                        {groupBy === "agent" ? agentDisplayName(row.key) : row.name}
                      </span>
                    </span>
                  </td>
                  <td className="max-w-0 truncate px-2 py-2 text-muted">{row.projects.join(", ")}</td>
                  <td className="px-2 py-2 text-right font-mono text-text-2">{formatNumber(row.sessions)}</td>
                  <td className="px-2 py-2 text-right font-mono text-text">{formatTokenCount(row.totals.tokens)}</td>
                  <td className="px-2 py-2 text-right font-mono text-text-2">{formatCost(row.totals.costUsd, row.totals.hasUnpricedEntries)}</td>
                  <td className="px-4 py-2 text-right font-mono text-muted">{formatPercent(row.share)}</td>
                </tr>
              ))}
              <tr className="border-t border-border font-semibold">
                <td className="px-4 py-2 text-text">{s.reports.cost.total}</td>
                <td />
                <td className="px-2 py-2 text-right font-mono text-text">{formatNumber(r.sessions)}</td>
                <td className="px-2 py-2 text-right font-mono text-text">{formatTokenCount(r.totals.tokens)}</td>
                <td className="px-2 py-2 text-right font-mono text-text">{formatCost(r.totals.costUsd, r.totals.hasUnpricedEntries)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </Card>
      <p className="m-0 text-small text-muted">{s.reports.cost.note}</p>
    </div>
  );
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-label font-semibold uppercase tracking-[0.08em] text-faint">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-control border border-border bg-surface-3 px-2 font-mono text-body text-text"
      />
    </label>
  );
}
