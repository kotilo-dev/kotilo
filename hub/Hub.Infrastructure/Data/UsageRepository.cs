using Hub.Core.Sessions;
using Hub.Core.Usage;
using Dapper;

namespace Hub.Infrastructure.Data;

/// <summary>
/// <c>usage_entries</c> (spec §13). Column <c>cache_create</c> holds the 5-minute writes and
/// <c>cache_create_1h</c> the 1-hour writes. Duplicates resolve with the D-010 "larger wins" rule.
/// </summary>
public sealed class UsageRepository(Database db)
{
    private const string SelectColumns =
        """
        SELECT dedup_key AS DedupKey, agent AS Agent, session_id AS SessionId, project_root AS ProjectRoot, model AS Model, ts AS Ts,
               input AS Input, output AS Output, cache_create AS CacheCreate5m, cache_create_1h AS CacheCreate1h,
               cache_read AS CacheRead, cost_usd AS CostUsd, sidechain AS Sidechain, fast AS Fast, cost_reported AS CostReported
        FROM usage_entries
        """;

    /// <summary>Inserts new entries and applies duplicate replacement. Returns the number of rows written.</summary>
    public int Upsert(IReadOnlyCollection<UsageEntry> entries)
    {
        if (entries.Count == 0)
        {
            return 0;
        }

        using var c = db.Open();
        using var tx = c.BeginTransaction();
        var written = 0;
        foreach (var e in entries)
        {
            written += c.Execute(
                """
                INSERT INTO usage_entries (dedup_key, agent, session_id, project_root, model, ts, input, output,
                                           cache_create, cache_create_1h, cache_read, cost_usd, sidechain, fast, cost_reported)
                VALUES (@DedupKey, @Agent, @SessionId, @ProjectRoot, @Model, @Ts, @Input, @Output,
                        @CacheCreate5m, @CacheCreate1h, @CacheRead, @CostUsd, @Sidechain, @Fast, @CostReported)
                ON CONFLICT(dedup_key) DO UPDATE SET
                    agent = excluded.agent, session_id = excluded.session_id, project_root = excluded.project_root, model = excluded.model,
                    ts = excluded.ts, input = excluded.input, output = excluded.output,
                    cache_create = excluded.cache_create, cache_create_1h = excluded.cache_create_1h,
                    cache_read = excluded.cache_read, cost_usd = excluded.cost_usd, cost_reported = excluded.cost_reported,
                    sidechain = excluded.sidechain, fast = excluded.fast
                WHERE (usage_entries.sidechain = 1 AND excluded.sidechain = 0)
                   OR (usage_entries.sidechain = excluded.sidechain
                       AND (excluded.input + excluded.output + excluded.cache_create + excluded.cache_create_1h + excluded.cache_read)
                         > (usage_entries.input + usage_entries.output + usage_entries.cache_create + usage_entries.cache_create_1h + usage_entries.cache_read))
                """,
                Params(e),
                tx);
        }

        tx.Commit();
        return written;
    }

    public IReadOnlyList<UsageEntry> Load(DateTimeOffset since)
    {
        using var c = db.Open();
        return c.Query<Row>(SelectColumns + " WHERE ts >= @since ORDER BY ts", new { since = since.ToUnixTimeMilliseconds() })
            .Select(r => r.ToModel())
            .ToList();
    }

    public IReadOnlyDictionary<string, SessionUsage> SessionTotals(IEnumerable<string> sessionIds)
    {
        var ids = sessionIds.ToArray();
        if (ids.Length == 0)
        {
            return new Dictionary<string, SessionUsage>();
        }

        using var c = db.Open();
        return c.Query<(string SessionId, long Tokens, double? Cost, long Unpriced, string? Model)>(
                """
                SELECT session_id, SUM(input + output + cache_create + cache_create_1h + cache_read),
                       SUM(cost_usd), SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END),
                       (SELECT u2.model FROM usage_entries u2 WHERE u2.session_id = u.session_id AND u2.model <> '<synthetic>'
                        ORDER BY u2.ts DESC LIMIT 1)
                FROM usage_entries u
                WHERE session_id IN @ids
                GROUP BY session_id
                """,
                new { ids })
            .ToDictionary(
                r => r.SessionId,
                r => new SessionUsage(r.Tokens, r.Unpriced > 0 ? null : (decimal?)(decimal)(r.Cost ?? 0), r.Model),
                StringComparer.Ordinal);
    }

    /// <summary>
    /// Last main-chain API response per session: its context size (input + cache read + cache creation, spec §18.4),
    /// model and time.
    /// </summary>
    public IReadOnlyDictionary<string, (long Tokens, string? Model, DateTimeOffset At)> LastContext(IEnumerable<string> sessionIds)
    {
        var ids = sessionIds.ToArray();
        if (ids.Length == 0)
        {
            return new Dictionary<string, (long, string?, DateTimeOffset)>();
        }

        using var c = db.Open();
        return c.Query<(string SessionId, long Tokens, string? Model, long Ts)>(
                """
                SELECT u.session_id, u.input + u.cache_create + u.cache_create_1h + u.cache_read, u.model, u.ts
                FROM usage_entries u
                WHERE u.session_id IN @ids AND u.sidechain = 0 AND COALESCE(u.model, '') <> '<synthetic>'
                  AND u.ts = (SELECT MAX(x.ts) FROM usage_entries x
                              WHERE x.session_id = u.session_id AND x.sidechain = 0 AND COALESCE(x.model, '') <> '<synthetic>')
                """,
                new { ids })
            .GroupBy(r => r.SessionId, StringComparer.Ordinal)
            .ToDictionary(
                g => g.Key,
                g => g.Select(r => (r.Tokens, r.Model, DateTimeOffset.FromUnixTimeMilliseconds(r.Ts))).First(),
                StringComparer.Ordinal);
    }

    /// <summary>Re-prices every stored entry (after pricing.json changed), except costs the agent reported itself.</summary>
    public int Reprice(PricingTable pricing)
    {
        using var c = db.Open();
        var rows = c.Query<Row>(SelectColumns + " WHERE cost_reported = 0").Select(r => r.ToModel()).ToList();
        using var tx = c.BeginTransaction();
        foreach (var e in rows)
        {
            c.Execute("UPDATE usage_entries SET cost_usd = @cost WHERE dedup_key = @key", new { cost = pricing.Cost(e), key = e.DedupKey }, tx);
        }

        tx.Commit();
        return rows.Count;
    }

    /// <summary>Retention (spec §13): 90 days.</summary>
    public int Prune(DateTimeOffset olderThan)
    {
        using var c = db.Open();
        return c.Execute("DELETE FROM usage_entries WHERE ts < @cutoff", new { cutoff = olderThan.ToUnixTimeMilliseconds() });
    }

    private static object Params(UsageEntry e) => new
    {
        e.DedupKey,
        e.Agent,
        e.SessionId,
        e.ProjectRoot,
        e.Model,
        Ts = e.Timestamp.ToUnixTimeMilliseconds(),
        e.Input,
        e.Output,
        e.CacheCreate5m,
        e.CacheCreate1h,
        e.CacheRead,
        e.CostUsd,
        Sidechain = e.IsSidechain ? 1 : 0,
        Fast = e.IsFast ? 1 : 0,
        CostReported = e.CostReported ? 1 : 0,
    };

    private sealed class Row
    {
        public string DedupKey { get; set; } = "";

        public string Agent { get; set; } = Hub.Core.Hooks.HookEnvelope.DefaultAgent;

        public string? SessionId { get; set; }

        public string? ProjectRoot { get; set; }

        public string? Model { get; set; }

        public long Ts { get; set; }

        public long Input { get; set; }

        public long Output { get; set; }

        public long CacheCreate5m { get; set; }

        public long CacheCreate1h { get; set; }

        public long CacheRead { get; set; }

        public double? CostUsd { get; set; }

        public long Sidechain { get; set; }

        public long Fast { get; set; }

        public long CostReported { get; set; }

        public UsageEntry ToModel() =>
            new(DedupKey, DateTimeOffset.FromUnixTimeMilliseconds(Ts), Input, Output, CacheCreate5m, CacheCreate1h, CacheRead)
            {
                Agent = Agent,
                SessionId = SessionId,
                ProjectRoot = ProjectRoot,
                Model = Model,
                CostUsd = CostUsd is { } c ? (decimal)c : null,
                IsSidechain = Sidechain != 0,
                IsFast = Fast != 0,
                CostReported = CostReported != 0,
            };
    }
}
