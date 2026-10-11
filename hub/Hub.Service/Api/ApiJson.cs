using System.Text.Json;
using System.Text.Json.Serialization;
using Hub.Core.Insights;
using Hub.Core.Sessions;
using Hub.Core.Usage;
using Hub.Service.Hosting;
using Microsoft.AspNetCore.Http;

namespace Hub.Service.Api;

/// <summary>JSON conventions of the hub API (docs/hub-api.md): camelCase, enums as camelCase strings, errors as <see cref="ApiError"/>.</summary>
internal static class ApiJson
{
    public static readonly JsonSerializerOptions Options = CreateOptions();

    public static IResult Ok(object value) => Results.Json(value, Options);

    public static IResult Created(object value) => Results.Json(value, Options, statusCode: StatusCodes.Status201Created);

    public static IResult Error(int status, string error, string message, IReadOnlyDictionary<string, string[]>? fields = null) =>
        Results.Json(new ApiError(error, message, fields), Options, statusCode: status);

    public static IResult NotFound(string message) => Error(StatusCodes.Status404NotFound, "notFound", message);

    public static IResult BadRequest(string message, IReadOnlyDictionary<string, string[]>? fields = null) =>
        Error(StatusCodes.Status400BadRequest, "invalidRequest", message, fields);

    /// <summary>Reads a JSON body; null (and a ready 400 result) when it is missing or malformed.</summary>
    public static async Task<(T? Value, IResult? Error)> ReadAsync<T>(HttpRequest request)
        where T : class
    {
        try
        {
            var value = await JsonSerializer.DeserializeAsync<T>(request.Body, Options, request.HttpContext.RequestAborted);
            return value is null ? (null, BadRequest("A JSON body is required.")) : (value, null);
        }
        catch (JsonException ex)
        {
            return (null, BadRequest("The body is not valid JSON: " + ex.Message));
        }
    }

    public static byte[] Serialize(object value) => JsonSerializer.SerializeToUtf8Bytes(value, Options);

    private static JsonSerializerOptions CreateOptions()
    {
        var o = new JsonSerializerOptions(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };
        o.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
        return o;
    }
}

/// <summary>Error body of every non-2xx answer. <c>fields</c>: per-field messages for validation errors.</summary>
public sealed record ApiError(string Error, string Message, IReadOnlyDictionary<string, string[]>? Fields = null);

public sealed record PendingPermissionDto(string? Tool, string? Command, string? Path, PermissionRisk? Risk, DateTimeOffset Since);

public sealed record SessionErrorDto(SessionErrorKind Kind, DateTimeOffset? ResetsAt);

public sealed record TaskProgressDto(int Completed, int InProgress, int Total);

/// <summary>
/// One session as seen by <c>/v1/sessions</c> and the <c>sessions</c> stream message. <c>state</c> keeps the C# names (M1 wire format).
/// <c>unseen</c>: a turn finished after the user last looked and the session is Idle, Ended or Stale.
/// </summary>
public sealed record SessionDto(
    string SessionId,
    string Agent,
    string? PaneId,
    string ProjectRoot,
    string ProjectName,
    string State,
    DateTimeOffset StateSince,
    DateTimeOffset LastEventAt,
    string? CurrentTool,
    string? Model,
    long Tokens,
    decimal? CostUsd,
    double? ContextUsedPercent,
    DateTimeOffset? TurnStartedAt,
    DateTimeOffset? EndedAt,
    int ActiveSubagents,
    string? LastNotification,
    SessionErrorDto? Error,
    TaskProgressDto? Tasks,
    PendingPermissionDto? PendingPermission,
    DateTimeOffset? LastCompletedAt,
    bool Unseen)
{
    public static SessionDto From(SessionInfo s) => new(
        s.SessionId,
        s.Agent,
        s.PaneId,
        s.ProjectRoot,
        s.ProjectName,
        s.State.ToString(),
        s.StateSince,
        s.LastEventAt,
        s.CurrentTool,
        s.Model,
        s.TokensThisSession,
        s.CostUsdThisSession,
        s.ContextUsedPercent,
        s.TurnStartedAt,
        s.EndedAt,
        s.ActiveSubagents,
        s.LastNotification,
        s.Error is { } e ? new SessionErrorDto(e.Kind, e.ResetsAt) : null,
        s.Tasks is { } t ? new TaskProgressDto(t.Completed, t.InProgress, t.Total) : null,
        s.State == SessionState.WaitingPermission && s.PendingPermission is { } p
            ? new PendingPermissionDto(p.Tool, p.Command, p.Path, p.Risk, p.Since)
            : null,
        s.LastCompletedAt,
        s.IsUnseen);
}

public sealed record TotalsDto(long Input, long Output, long CacheCreate, long CacheRead, long Tokens, decimal CostUsd, bool HasUnpricedEntries, int Entries)
{
    public static TotalsDto From(UsageTotals t) =>
        new(t.Input, t.Output, t.CacheCreate, t.CacheRead, t.TotalTokens, t.CostUsd, t.HasUnpricedEntries, t.Entries);
}

public sealed record ActiveBlockDto(
    DateTimeOffset Start, DateTimeOffset End, long Tokens, decimal CostUsd, int RemainingMinutes, double TokensPerMinute, long ProjectedTokens, decimal ProjectedCostUsd);

public sealed record PeriodDto(long Tokens, decimal CostUsd, int? Sessions);

/// <summary><c>/v1/usage/current</c> and the <c>usage</c> stream message.</summary>
public sealed record UsageCurrentDto(DateTimeOffset At, ActiveBlockDto? ActiveBlock, PeriodDto Today, PeriodDto Week, bool BackfillDone)
{
    public static UsageCurrentDto From(UsageSnapshot u)
    {
        var b = u.ActiveBlock;
        return new UsageCurrentDto(
            u.At,
            b is null
                ? null
                : new ActiveBlockDto(
                    b.Block.Start, b.Block.End, b.Block.Totals.TotalTokens, b.Block.Totals.CostUsd, (int)b.Remaining.TotalMinutes,
                    Math.Round(b.TokensPerMinute), b.ProjectedTokens, b.ProjectedCostUsd),
            new PeriodDto(u.Today.TotalTokens, u.Today.CostUsd, u.TodaySessions),
            new PeriodDto(u.Week.TotalTokens, u.Week.CostUsd, null),
            u.BackfillDone);
    }
}

/// <summary>One plan-limit window (contract: <c>window</c> is <c>fiveHour</c> or <c>weekly</c>).</summary>
public sealed record LimitDto(string Agent, string Window, double UsedPercent, DateTimeOffset ResetsAt)
{
    public static IReadOnlyList<LimitDto> From(IEnumerable<PlanLimits?> stores, DateTimeOffset now)
    {
        var result = new List<LimitDto>();
        foreach (var limits in stores)
        {
            if (limits is null)
            {
                continue;
            }

            var current = limits.Current(now);
            if (current.FiveHour is { } five)
            {
                result.Add(new LimitDto(current.Agent, "fiveHour", five.UsedPercent, five.ResetsAt));
            }

            if (current.SevenDay is { } week)
            {
                result.Add(new LimitDto(current.Agent, "weekly", week.UsedPercent, week.ResetsAt));
            }
        }

        return result;
    }
}

public sealed record HealthIssueDto(string Check, string Severity, IReadOnlyList<string> Detail);

/// <summary><c>/v1/health</c> and the <c>health</c> stream message.</summary>
public sealed record HealthDto(string? Version, long Uptime, string Status, IReadOnlyList<HealthIssueDto> Issues)
{
    public static HealthDto From(IReadOnlyList<HealthIssue> issues, DateTimeOffset startedAt) => new(
        typeof(HealthDto).Assembly.GetName().Version?.ToString(),
        (long)(DateTimeOffset.UtcNow - startedAt).TotalSeconds,
        issues.Count == 0 ? "ok" : issues[0].Severity.ToString().ToLowerInvariant(),
        issues.Select(i => new HealthIssueDto(i.Check.ToString(), i.Severity.ToString(), i.Detail.ToList())).ToList());
}

/// <summary>
/// One timeline entry (<c>GET /v1/sessions/{agent}/{id}/activity</c>, <c>activity</c> stream frames). Tool entries:
/// <c>{ id, kind, tool, target, paths?, startedAt, durationMs?, status }</c>; turn markers: <c>{ id, kind: "turn", at }</c>.
/// </summary>
public sealed record ActivityEntryDto(
    long Id,
    Hub.Core.Activity.ActivityKind Kind,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Tool,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Target,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? Paths,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] DateTimeOffset? StartedAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? DurationMs,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Hub.Core.Activity.ActivityStatus? Status,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] DateTimeOffset? At)
{
    public static ActivityEntryDto From(Hub.Core.Activity.ActivityEntry e) => e.Kind == Hub.Core.Activity.ActivityKind.Turn
        ? new(e.Id, e.Kind, null, null, null, null, null, null, e.At)
        : new(e.Id, e.Kind, e.Tool, e.Target, e.Paths, e.At, e.DurationMs, e.Status, null);
}

public sealed record ActivityPlanItemDto(string Text, string Status);

public sealed record ActivityPlanDto(IReadOnlyList<ActivityPlanItemDto> Items)
{
    public static ActivityPlanDto? From(Hub.Core.Activity.ActivityPlan? plan) =>
        plan is null ? null : new(plan.Items.Select(i => new ActivityPlanItemDto(i.Text, i.Status)).ToList());
}

/// <summary><c>GET /v1/sessions/{agent}/{id}/activity</c>: the whole ring (oldest first) and the latest plan.</summary>
public sealed record ActivityDto(IReadOnlyList<ActivityEntryDto> Entries, ActivityPlanDto? Plan)
{
    public static ActivityDto From(Hub.Core.Activity.ActivitySnapshot? s) =>
        s is null ? new([], null) : new(s.Entries.Select(ActivityEntryDto.From).ToList(), ActivityPlanDto.From(s.Plan));
}

/// <summary><c>activity</c> stream frame: entries new or changed since the previous frame of that session, and the current plan.</summary>
public sealed record ActivityFrameDto(string Agent, string SessionId, IReadOnlyList<ActivityEntryDto> Entries, ActivityPlanDto? Plan)
{
    public static ActivityFrameDto From(Hub.Core.Activity.ActivityDelta d) =>
        new(d.Agent, d.SessionId, d.Entries.Select(ActivityEntryDto.From).ToList(), ActivityPlanDto.From(d.Plan));
}
