using System.Globalization;
using Hub.Core.Sessions;
using Hub.Core.Usage;
using Hub.Service.Hosting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Hub.Service.Api;

public sealed record AgentTotalsDto(long Tokens, decimal CostUsd, bool HasUnpricedEntries);

public sealed record DailyUsageDto(DateOnly Date, long Tokens, decimal CostUsd, bool HasUnpricedEntries, int Sessions, IReadOnlyDictionary<string, AgentTotalsDto> ByAgent);

public sealed record BlockDto(string Id, DateTimeOffset Start, DateTimeOffset End, DateTimeOffset? LastEntryAt, bool IsGap, bool IsActive, TotalsDto Totals);

public sealed record BreakdownRowDto(string Key, string Name, TotalsDto Totals);

public sealed record TransitionDto(string From, string To, DateTimeOffset At, string? Detail);

/// <summary>Sessions, usage and plan limits (docs/hub-api.md §Sessions, §Usage, §Limits).</summary>
internal static class UsageEndpoints
{
    public const int MaxDays = 90;

    private static readonly TimeSpan SeenTimeout = TimeSpan.FromSeconds(5);

    public static void Map(IEndpointRouteBuilder app, AppHost host)
    {
        app.MapGet("/v1/sessions/{agent}/{id}/transitions", (string agent, string id) =>
        {
            var known = host.Tracker.Snapshot.Any(s => s.Agent == agent && s.SessionId == id)
                || host.Repository.LoadHistory(DateTimeOffset.UtcNow.AddDays(-MaxDays), 1000).Any(s => s.Agent == agent && s.SessionId == id);
            if (!known)
            {
                return ApiJson.NotFound($"No session {agent}/{id}.");
            }

            return ApiJson.Ok(host.Repository.GetTransitions(id)
                .Select(t => new TransitionDto(t.From.ToString(), t.To.ToString(), t.At, t.Detail))
                .ToList());
        });

        // Memory only (M4): the ring of a session the tracker knows; empty for a known session without tool activity.
        app.MapGet("/v1/sessions/{agent}/{id}/activity", (string agent, string id) =>
        {
            var activity = host.Pipeline.Activity.Get(agent, id);
            if (activity is null && !host.Tracker.Snapshot.Any(s => s.Agent == agent && s.SessionId == id))
            {
                return ApiJson.NotFound($"No session {agent}/{id}.");
            }

            return ApiJson.Ok(ActivityDto.From(activity));
        });

        // The user looked at a session's finished work (0.3). The change reaches clients through the `sessions` stream.
        app.MapPost("/v1/sessions/{agent}/{id}/seen", async (string agent, string id) =>
            await host.Pipeline.MarkSeenAsync(agent, id).WaitAsync(SeenTimeout)
                ? Results.NoContent()
                : ApiJson.NotFound($"No session {agent}/{id}."));

        app.MapPost("/v1/sessions/seen", async () =>
        {
            await host.Pipeline.MarkAllSeenAsync().WaitAsync(SeenTimeout);
            return Results.NoContent();
        });

        app.MapGet("/v1/usage/daily", (int? days) =>
        {
            if (Days(days, 30) is not { } n)
            {
                return DaysError();
            }

            var zone = TimeZoneInfo.Local;
            var today = UsageAggregator.LocalDate(DateTimeOffset.UtcNow, zone);
            var entries = host.Usage.Repository.Load(StartOf(today.AddDays(-(n - 1)), zone));
            var byAgent = entries.GroupBy(e => e.Agent, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);
            var perAgentDaily = byAgent.ToDictionary(
                kv => kv.Key,
                kv => UsageAggregator.Daily(kv.Value, zone, today.AddDays(-(n - 1)), today).ToDictionary(d => d.Date),
                StringComparer.Ordinal);
            var rows = UsageAggregator.Daily(entries, zone, today.AddDays(-(n - 1)), today)
                .Select(d => new DailyUsageDto(
                    d.Date, d.Totals.TotalTokens, d.Totals.CostUsd, d.Totals.HasUnpricedEntries, d.Sessions,
                    perAgentDaily
                        .Where(a => a.Value[d.Date].Totals.Entries > 0)
                        .ToDictionary(
                            a => a.Key,
                            a => new AgentTotalsDto(a.Value[d.Date].Totals.TotalTokens, a.Value[d.Date].Totals.CostUsd, a.Value[d.Date].Totals.HasUnpricedEntries),
                            StringComparer.Ordinal)))
                .ToList();
            return ApiJson.Ok(rows);
        });

        app.MapGet("/v1/usage/blocks", (int? days) =>
        {
            if (Days(days, 7) is not { } n)
            {
                return DaysError();
            }

            var now = DateTimeOffset.UtcNow;
            var entries = host.Usage.Repository.Load(now.AddDays(-n));
            var active = BlockCalculator.Active(entries, now)?.Block.Id;
            return ApiJson.Ok(BlockCalculator.Identify(entries)
                .OrderByDescending(b => b.Start)
                .Select(b => new BlockDto(b.Id, b.Start, b.End, b.LastEntryAt, b.IsGap, b.Id == active, TotalsDto.From(b.Totals)))
                .ToList());
        });

        app.MapGet("/v1/usage/breakdown", (string? by, int? days) =>
        {
            if (Days(days, 30) is not { } n)
            {
                return DaysError();
            }

            var since = StartOf(UsageAggregator.LocalDate(DateTimeOffset.UtcNow, TimeZoneInfo.Local).AddDays(-(n - 1)), TimeZoneInfo.Local);
            var entries = host.Usage.Repository.Load(since);
            var names = ProjectNames(host);
            IReadOnlyList<BreakdownRowDto>? rows = (by ?? "project").ToLowerInvariant() switch
            {
                "project" => UsageAggregator.ByProject(entries)
                    .Select(b => new BreakdownRowDto(b.Key, names(b.Key), TotalsDto.From(b.Totals))).ToList(),
                "model" => UsageAggregator.ByModel(entries)
                    .Select(b => new BreakdownRowDto(b.Key, b.Key, TotalsDto.From(b.Totals))).ToList(),
                "agent" => entries.GroupBy(e => e.Agent, StringComparer.Ordinal)
                    .Select(g => new BreakdownRowDto(g.Key, g.Key, TotalsDto.From(UsageTotals.Sum(g))))
                    .OrderByDescending(r => r.Totals.Tokens).ToList(),
                _ => null,
            };
            return rows is null
                ? ApiJson.BadRequest("'by' must be project, model or agent.", new Dictionary<string, string[]> { ["by"] = ["project | model | agent"] })
                : ApiJson.Ok(rows);
        });

        app.MapGet("/v1/limits", () => ApiJson.Ok(Limits(host)));
    }

    public static IReadOnlyList<SessionDto> Sessions(AppHost host, bool includeEnded)
    {
        var live = host.Tracker.Snapshot;
        var dtos = live.Select(SessionDto.From).ToList();
        if (includeEnded)
        {
            // Unseen work belongs to the live view: the tracker forgets an ended session after 30 minutes, and so does "unseen".
            var known = live.Select(s => (s.Agent, s.SessionId)).ToHashSet();
            dtos.AddRange(host.Repository.LoadHistory(DateTimeOffset.UtcNow.AddDays(-7), 200)
                .Where(s => !known.Contains((s.Agent, s.SessionId)))
                .Select(s => SessionDto.From(s) with { Unseen = false }));
        }

        return dtos;
    }

    public static IReadOnlyList<LimitDto> Limits(AppHost host) =>
        LimitDto.From(host.PlanLimits.All.Select(s => s.Limits), DateTimeOffset.UtcNow);

    /// <summary>Display name for a project root: the project list's name (alias aware), else the folder name.</summary>
    public static Func<string, string> ProjectNames(AppHost host)
    {
        var known = host.Projects.Current.ToDictionary(p => p.Root, p => p.Name, StringComparer.OrdinalIgnoreCase);
        return root => known.TryGetValue(root, out var name) ? name : SessionInfo.ProjectNameFrom(root);
    }

    public static DateTimeOffset StartOf(DateOnly day, TimeZoneInfo zone) => Hub.Core.Insights.WaitMetricsCalculator.StartOfDay(day, zone);

    private static int? Days(int? days, int fallback) => days switch
    {
        null => fallback,
        >= 1 and <= MaxDays => days,
        _ => null,
    };

    private static IResult DaysError() => ApiJson.BadRequest(
        string.Create(CultureInfo.InvariantCulture, $"'days' must be 1..{MaxDays}."),
        new Dictionary<string, string[]> { ["days"] = [string.Create(CultureInfo.InvariantCulture, $"1..{MaxDays}")] });
}
