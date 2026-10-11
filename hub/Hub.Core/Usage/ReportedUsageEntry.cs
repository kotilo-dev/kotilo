using System.Globalization;
using Hub.Core.Hooks;

namespace Hub.Core.Usage;

/// <summary>Protocol <c>usage</c> event → <see cref="UsageEntry"/> (Agent Integration Protocol v1).</summary>
public static class ReportedUsageEntry
{
    /// <summary>
    /// One row per event: deduplicated by agent + session + event time, so a replayed (spooled) event is stored once.
    /// Cached tokens are cache reads; the agent's own <c>costUsd</c> wins over the price table.
    /// </summary>
    /// <param name="projectRoot">The session's project when the event has no <c>cwd</c>.</param>
    public static UsageEntry? From(HookEvent e, string? projectRoot)
    {
        if (e.Kind != HookEventKind.Usage || e.Usage is not { } u)
        {
            return null;
        }

        var key = string.Create(CultureInfo.InvariantCulture, $"{e.Agent}:{e.SessionId}:{e.ReceivedAt.ToUnixTimeMilliseconds()}");
        return new UsageEntry(key, e.ReceivedAt, u.InputTokens, u.OutputTokens, CacheCreate5m: 0, CacheCreate1h: 0, CacheRead: u.CachedTokens)
        {
            Agent = e.Agent,
            SessionId = e.SessionId,
            ProjectRoot = e.Cwd ?? projectRoot,
            Model = u.Model ?? e.Model,
            CostUsd = u.CostUsd,
            CostReported = u.CostUsd is not null,
        };
    }
}
