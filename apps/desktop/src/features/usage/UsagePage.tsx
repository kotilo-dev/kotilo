/**
 * Usage (M2, CCC spec §12.4): 30-day daily bars (tokens or cost, all agents or one), 5-hour
 * block history, breakdown by project / model / agent. Costs are local API-price estimates;
 * unpriced usage (e.g. Codex) shows "—".
 */
import { useEffect, useRef, useState } from "react";
import { formatNumber, useStrings } from "../../app/i18n";
import {
  AgentAvatar,
  Button,
  Card,
  EmptyState,
  Page,
  PageHeader,
  Segmented,
  agentDisplayName,
  formatClock,
  formatCost,
  formatTokenCount,
  formatCurrencyCompact,
  useHubQuery,
} from "../../app/ui";
import type { BreakdownRow, DailyUsage, UsageBlockDto } from "../../lib/hubTypes";
import { useHubStore } from "../../stores/hubStore";
import { BarChart } from "./BarChart";
import { agentsIn, dailyBars, relativeShares, type UsageMetric } from "./usageLogic";

type BreakdownBy = "project" | "model" | "agent";
const ALL = "__all__";
/** Live usage changes reload the lists at most this often. */
const RELOAD_THROTTLE_MS = 30_000;

export function UsagePage() {
  const s = useStrings();
  const daily = useHubQuery<DailyUsage[]>("/v1/usage/daily?days=30");
  const blocks = useHubQuery<UsageBlockDto[]>("/v1/usage/blocks?days=7");
  const [by, setBy] = useState<BreakdownBy>("project");
  const breakdown = useHubQuery<BreakdownRow[]>(`/v1/usage/breakdown?by=${by}&days=30`);

  // Follow live usage without hammering the hub: reload when today's total moves.
  const todayTokens = useHubStore((st) => st.usage?.today.tokens ?? null);
  const lastReload = useRef(Date.now());
  const { reload: reloadDaily } = daily;
  const { reload: reloadBlocks } = blocks;
  useEffect(() => {
    if (todayTokens === null || Date.now() - lastReload.current < RELOAD_THROTTLE_MS) return;
    lastReload.current = Date.now();
    reloadDaily();
    reloadBlocks();
  }, [todayTokens, reloadDaily, reloadBlocks]);

  const unavailable = daily.unavailable || blocks.unavailable;
  const refresh = () => {
    daily.reload();
    blocks.reload();
    breakdown.reload();
  };

  return (
    <Page>
      <PageHeader
        title={s.nav.usage}
        subtitle={s.usage.subtitle}
        actions={
          <Button onClick={refresh} aria-label={s.ui.refresh}>
            {s.ui.refresh}
          </Button>
        }
      />
      {unavailable ? (
        <Card>
          <EmptyState title={s.ui.hubUnavailableTitle} body={s.ui.hubUnavailableBody} />
        </Card>
      ) : (
        <>
          <DailyCard days={daily.data} loading={daily.loading} error={daily.error} />
          <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2">
            <BlocksCard blocks={blocks.data} loading={blocks.loading} />
            <BreakdownCard rows={breakdown.data} loading={breakdown.loading} by={by} onBy={setBy} />
          </div>
          <p className="m-0 text-small text-muted">{s.usage.unpricedNote}</p>
        </>
      )}
    </Page>
  );
}

function DailyCard({ days, loading, error }: { days: DailyUsage[] | null; loading: boolean; error: string | null }) {
  const s = useStrings();
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const [agent, setAgent] = useState<string>(ALL);
  const list = days ?? [];
  const agents = agentsIn(list);
  const bars = dailyBars(list, metric, agent === ALL ? null : agent);
  const metricLabel = metric === "tokens" ? s.usage.metricTokens : s.usage.metricCost;
  const empty = list.every((d) => d.tokens === 0);

  return (
    <Card
      title={s.usage.daily}
      labelledBy="usage-daily"
      actions={
        <div className="flex flex-wrap gap-2">
          {agents.length > 1 && (
            <Segmented
              ariaLabel={s.usage.agentFilter}
              value={agent}
              onChange={setAgent}
              options={[{ value: ALL, label: s.ui.allAgents }, ...agents.map((a) => ({ value: a, label: agentDisplayName(a) }))]}
            />
          )}
          <Segmented
            ariaLabel={s.usage.metric}
            value={metric}
            onChange={setMetric}
            options={[
              { value: "tokens", label: s.usage.metricTokens },
              { value: "cost", label: s.usage.metricCost },
            ]}
          />
        </div>
      }
    >
      {loading && !days ? (
        <p className="m-0 text-muted">{s.ui.loading}</p>
      ) : error && !days ? (
        <EmptyState title={s.ui.loadFailed} body={error} />
      ) : empty ? (
        <EmptyState title={s.usage.empty} />
      ) : (
        <BarChart
          data={bars}
          ariaLabel={s.usage.chartLabel(metricLabel)}
          formatAxis={(v) => (metric === "tokens" ? formatTokenCount(v) : formatCurrencyCompact(v))}
        />
      )}
    </Card>
  );
}

function BlocksCard({ blocks, loading }: { blocks: UsageBlockDto[] | null; loading: boolean }) {
  const s = useStrings();
  const rows = (blocks ?? []).filter((b) => !b.isGap || b.isActive);
  return (
    <Card title={s.usage.blocks} labelledBy="usage-blocks" bodyClassName="p-0">
      {loading && !blocks ? (
        <p className="m-0 p-4 text-muted">{s.ui.loading}</p>
      ) : rows.length === 0 ? (
        <EmptyState title={s.usage.empty} />
      ) : (
        <table className="w-full border-collapse text-body">
          <thead>
            <tr className="text-left text-label uppercase tracking-[0.08em] text-faint">
              <th className="px-4 py-2 font-semibold">{s.usage.columns.block}</th>
              <th className="px-2 py-2 text-right font-semibold">{s.usage.columns.tokens}</th>
              <th className="px-2 py-2 text-right font-semibold">{s.usage.columns.cost}</th>
              <th className="px-4 py-2 text-right font-semibold">{s.usage.columns.entries}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id} className="border-t border-border-subtle">
                <td className="px-4 py-2 text-text-2">
                  <span className="font-mono">
                    {formatClock(b.start)}–{formatClock(b.end)}
                  </span>
                  {b.isActive && (
                    <span className="ml-2 rounded-badge bg-accent-soft px-1.5 py-0.5 text-label text-accent">{s.usage.active}</span>
                  )}
                </td>
                <td className="px-2 py-2 text-right font-mono text-text">{formatTokenCount(b.totals.tokens)}</td>
                <td className="px-2 py-2 text-right font-mono text-text-2">
                  {formatCost(b.totals.costUsd, b.totals.hasUnpricedEntries)}
                </td>
                <td className="px-4 py-2 text-right font-mono text-muted">{formatNumber(b.totals.entries)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function BreakdownCard({
  rows,
  loading,
  by,
  onBy,
}: {
  rows: BreakdownRow[] | null;
  loading: boolean;
  by: BreakdownBy;
  onBy: (by: BreakdownBy) => void;
}) {
  const s = useStrings();
  const list = rows ?? [];
  const shares = relativeShares(list.map((r) => r.totals.tokens));
  return (
    <Card
      title={s.usage.breakdown}
      labelledBy="usage-breakdown"
      bodyClassName="p-0"
      actions={
        <Segmented
          ariaLabel={s.usage.breakdown}
          value={by}
          onChange={onBy}
          options={[
            { value: "project", label: s.usage.byProject },
            { value: "model", label: s.usage.byModel },
            { value: "agent", label: s.usage.byAgent },
          ]}
        />
      }
    >
      {loading && !rows ? (
        <p className="m-0 p-4 text-muted">{s.ui.loading}</p>
      ) : list.length === 0 ? (
        <EmptyState title={s.usage.empty} />
      ) : (
        <table className="w-full border-collapse text-body">
          <thead>
            <tr className="text-left text-label uppercase tracking-[0.08em] text-faint">
              <th className="px-4 py-2 font-semibold">{s.usage.columns.name}</th>
              <th className="w-[30%] px-2 py-2 font-semibold">
                <span className="sr-only">{s.usage.columns.share}</span>
              </th>
              <th className="px-2 py-2 text-right font-semibold">{s.usage.columns.tokens}</th>
              <th className="px-4 py-2 text-right font-semibold">{s.usage.columns.cost}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r, i) => (
              <tr key={r.key} className="border-t border-border-subtle">
                <td className="max-w-0 px-4 py-2">
                  <span className="flex items-center gap-2">
                    {by === "agent" && <AgentAvatar agent={r.key} size={20} />}
                    <span className="truncate text-text">{by === "agent" ? agentDisplayName(r.key) : r.name}</span>
                  </span>
                </td>
                <td className="px-2 py-2">
                  <div className="h-[5px] overflow-hidden rounded-[3px] bg-track">
                    <div className="h-full rounded-[3px] bg-accent" style={{ width: `${(shares[i] ?? 0) * 100}%` }} />
                  </div>
                </td>
                <td className="px-2 py-2 text-right font-mono text-text">{formatTokenCount(r.totals.tokens)}</td>
                <td className="px-4 py-2 text-right font-mono text-text-2">
                  {formatCost(r.totals.costUsd, r.totals.hasUnpricedEntries)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
