using System.Text.Json;

namespace Hub.Core.Usage;

/// <summary>One rate-limit window from the statusLine <c>rate_limits</c> object: percent used and when it resets.</summary>
public sealed record LimitWindow(double UsedPercent, DateTimeOffset ResetsAt);

/// <summary>
/// The claude.ai plan limits Claude Code reports to the statusLine (documented fields <c>rate_limits.five_hour</c>,
/// <c>seven_day</c>, <c>spend_limit</c>; decision D-074). Present only for Pro / Max subscribers (or a gateway spend
/// limit) and only after a session's first API response. Account-wide, so the latest report from any session applies.
/// </summary>
public sealed record PlanLimits(DateTimeOffset ReceivedAt)
{
    /// <summary>Two reports of the same window may differ by a little rounding in <c>resets_at</c>.</summary>
    private static readonly TimeSpan SameWindowTolerance = TimeSpan.FromMinutes(2);

    /// <summary>Agent whose account these limits belong to (Claude Code statusLine, Codex rollout <c>rate_limits</c>).</summary>
    public string Agent { get; init; } = Hooks.HookEnvelope.DefaultAgent;

    public LimitWindow? FiveHour { get; init; }

    public LimitWindow? SevenDay { get; init; }

    public LimitWindow? SpendLimit { get; init; }

    public bool IsEmpty => FiveHour is null && SevenDay is null && SpendLimit is null;

    /// <summary>Reads <c>rate_limits</c> from the statusLine root object; null when absent or empty.</summary>
    public static PlanLimits? Parse(JsonElement root, DateTimeOffset at)
    {
        if (!root.TryGetProperty("rate_limits", out var limits) || limits.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var parsed = new PlanLimits(at)
        {
            FiveHour = Window(limits, "five_hour"),
            SevenDay = Window(limits, "seven_day"),
            SpendLimit = Window(limits, "spend_limit"),
        };
        return parsed.IsEmpty ? null : parsed;
    }

    /// <summary>Windows whose reset time has passed are dropped, as Claude Code itself does.</summary>
    public PlanLimits Current(DateTimeOffset now) => this with
    {
        FiveHour = Live(FiveHour, now),
        SevenDay = Live(SevenDay, now),
        SpendLimit = Live(SpendLimit, now),
    };

    /// <summary>
    /// Combines a new report with what is known. Several sessions report independently and an idle one can
    /// re-render with older numbers, so per window: a later reset time means a new window and wins; within the same
    /// window usage only grows, so the higher percentage wins; an earlier reset time is stale and ignored.
    /// </summary>
    public static PlanLimits Merge(PlanLimits? known, PlanLimits incoming)
    {
        if (known is null)
        {
            return incoming;
        }

        return new PlanLimits(incoming.ReceivedAt > known.ReceivedAt ? incoming.ReceivedAt : known.ReceivedAt)
        {
            Agent = incoming.Agent,
            FiveHour = MergeWindow(known.FiveHour, incoming.FiveHour),
            SevenDay = MergeWindow(known.SevenDay, incoming.SevenDay),
            SpendLimit = MergeWindow(known.SpendLimit, incoming.SpendLimit),
        };
    }

    private static LimitWindow? MergeWindow(LimitWindow? known, LimitWindow? incoming)
    {
        if (known is null || incoming is null)
        {
            return incoming ?? known;
        }

        if (incoming.ResetsAt - known.ResetsAt > SameWindowTolerance)
        {
            return incoming;
        }

        if (known.ResetsAt - incoming.ResetsAt > SameWindowTolerance)
        {
            return known;
        }

        return incoming.UsedPercent >= known.UsedPercent ? incoming : known;
    }

    private static LimitWindow? Live(LimitWindow? w, DateTimeOffset now) => w is not null && w.ResetsAt > now ? w : null;

    private static LimitWindow? Window(JsonElement limits, string name)
    {
        if (!limits.TryGetProperty(name, out var w) || w.ValueKind != JsonValueKind.Object
            || !w.TryGetProperty("used_percentage", out var used) || used.ValueKind != JsonValueKind.Number
            || !w.TryGetProperty("resets_at", out var resets) || resets.ValueKind != JsonValueKind.Number
            || !resets.TryGetInt64(out var epoch))
        {
            return null;
        }

        try
        {
            return new LimitWindow(Math.Max(0, used.GetDouble()), DateTimeOffset.FromUnixTimeSeconds(epoch));
        }
        catch (ArgumentOutOfRangeException)
        {
            return null;
        }
    }
}
