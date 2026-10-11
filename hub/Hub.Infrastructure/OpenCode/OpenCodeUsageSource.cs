using System.Globalization;
using System.Text.Json;
using Hub.Core.Adapters;
using Hub.Core.Ai;
using Hub.Core.Usage;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Usage;
using Microsoft.Data.Sqlite;

namespace Hub.Infrastructure.OpenCode;

/// <summary>
/// OpenCode v2 usage from its SQLite database (<c>opencode.db</c>, 2.0.22 <c>core/src/database/schema.gen.ts</c>). Each
/// <c>session_v2</c> row holds running totals (cost in USD as OpenCode priced it, tokens per type); a poll reads the sessions
/// active inside the backfill window and stores what grew since the last poll as one usage row per session. The last
/// totals per session live in the offset store, so restarts never count twice.
/// </summary>
/// <remarks>
/// The same file holds OpenCode's login tokens (<c>account</c>, <c>control_account</c>, <c>credential</c>): it is opened
/// read-only and only named columns of <c>session_v2</c> and <c>project</c> are selected (AGENTS.md rule 3). Token usage does
/// not move <c>time_updated</c> (<c>SessionProjector.applyUsage</c>), so activity is <c>max(time_updated, time_idle)</c>.
/// Assumed (UNVERIFIED with a real session): <c>tokens_input</c> excludes cache reads and <c>tokens_reasoning</c> is billed
/// as output. Sessions titled <see cref="CliAgentSpecs.RunTitle"/> are the hub's own AI runs and are skipped.
/// </remarks>
public sealed class OpenCodeUsageSource : DbPollingUsageSource
{
    private const string Query =
        """
        SELECT s.id, s.parent_id, s.title, s.directory, s.model, s.cost,
               s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write,
               max(s.time_updated, coalesce(s.time_idle, 0)) AS activity, p.worktree
        FROM session_v2 s LEFT JOIN project p ON p.id = s.project_id
        WHERE max(s.time_updated, coalesce(s.time_idle, 0)) >= @since
        """;

    private const long NanoPerUsd = 1_000_000_000;

    private readonly UsageSourceContext _context;
    private readonly TimeProvider _time;

    public OpenCodeUsageSource(string databasePath, UsageSourceContext context, TimeProvider? time = null)
        : base(AgentIds.OpenCode, databasePath, context, TimeSpan.FromSeconds(30))
    {
        _context = context;
        _time = time ?? TimeProvider.System;
    }

    /// <summary>
    /// <paramref name="cursor"/> is the backfill floor (epoch ms): this source always returns 0 as its cursor, because
    /// usage growth doesn't advance any timestamp it could continue from.
    /// </summary>
    protected override (IReadOnlyList<UsageEntry> Entries, long Cursor) ReadSince(long cursor)
    {
        List<Row> rows;
        try
        {
            rows = ReadRows(cursor);
        }
        catch (SqliteException)
        {
            // Locked, schema changed or not an OpenCode v2 DB: try again on the next change.
            return ([], 0);
        }

        var parents = rows.Where(r => r.ParentId is not null).ToDictionary(r => r.Id, r => r.ParentId!, StringComparer.Ordinal);
        var known = _context.Offsets.GetAll();
        var now = _time.GetUtcNow();
        var entries = new List<UsageEntry>();
        foreach (var r in rows)
        {
            if (r.Title == CliAgentSpecs.RunTitle)
            {
                continue;
            }

            var key = StateKey(r.Id);
            var before = Read(known, key);
            var after = new Totals(r.Input, r.Output + r.Reasoning, r.CacheRead, r.CacheWrite, (long)Math.Round(r.Cost * NanoPerUsd));
            if (!after.Covers(before))
            {
                // Totals only grow; smaller numbers mean the session was rebuilt (revert, re-import): start over from them.
                before = default;
            }

            var delta = after.Minus(before);
            if (delta.IsZero)
            {
                continue;
            }

            var first = !known.ContainsKey(key + ":in");
            entries.Add(new UsageEntry(
                string.Create(CultureInfo.InvariantCulture, $"{AgentIds.OpenCode}:{r.Id}:{after.Tokens}:{after.CostNano}"),
                first && r.Activity > 0 ? DateTimeOffset.FromUnixTimeMilliseconds(r.Activity) : now,
                Input: delta.Input,
                Output: delta.Output,
                CacheCreate5m: delta.CacheWrite,
                CacheCreate1h: 0,
                CacheRead: delta.CacheRead)
            {
                Agent = AgentIds.OpenCode,
                SessionId = Root(r.Id, parents),
                ProjectRoot = ProjectOf(r),
                Model = ModelOf(r.Model),
                IsSidechain = r.ParentId is not null,
                CostUsd = Math.Max(0, delta.CostNano) / (decimal)NanoPerUsd,
                CostReported = true,
            });
            Write(key, after);
        }

        return (entries, 0);
    }

    private List<Row> ReadRows(long since)
    {
        var builder = new SqliteConnectionStringBuilder { DataSource = DatabasePath, Mode = SqliteOpenMode.ReadOnly, Pooling = false };
        using var connection = new SqliteConnection(builder.ToString());
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = Query;
        command.Parameters.AddWithValue("@since", since);
        using var reader = command.ExecuteReader();
        var rows = new List<Row>();
        while (reader.Read())
        {
            rows.Add(new Row(
                reader.GetString(0),
                reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.IsDBNull(5) ? 0 : reader.GetDouble(5),
                Long(reader, 6), Long(reader, 7), Long(reader, 8), Long(reader, 9), Long(reader, 10), Long(reader, 11),
                reader.IsDBNull(12) ? null : reader.GetString(12)));
        }

        return rows;

        static long Long(SqliteDataReader reader, int i) => reader.IsDBNull(i) ? 0 : Math.Max(0, reader.GetInt64(i));
    }

    /// <summary>Sub-agent usage counts toward the session the user started (as far as the parents are in this read).</summary>
    private static string Root(string id, Dictionary<string, string> parents)
    {
        var current = id;
        for (var i = 0; i < 16 && parents.TryGetValue(current, out var parent); i++)
        {
            current = parent;
        }

        return current;
    }

    /// <summary>The project's worktree; the session directory for the global project (worktree <c>/</c>).</summary>
    private static string? ProjectOf(Row r) =>
        OpenCodeAdapter.WindowsPath(r.Worktree is { Length: > 1 } worktree ? worktree : r.Directory);

    /// <summary><c>model</c> is JSON <c>{id, providerID, variant?}</c>.</summary>
    internal static string? ModelOf(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String
                ? id.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private string StateKey(string sessionId) => $"opencode-session:{DatabasePath}:{sessionId}";

    private static Totals Read(IReadOnlyDictionary<string, TranscriptOffset> known, string key)
    {
        long Get(string field) => known.TryGetValue($"{key}:{field}", out var v) ? v.Offset : 0;
        return new Totals(Get("in"), Get("out"), Get("cr"), Get("cw"), Get("cost"));
    }

    private void Write(string key, Totals t)
    {
        var stamp = DateTime.SpecifyKind(DateTime.UnixEpoch, DateTimeKind.Utc);
        _context.Offsets.Set($"{key}:in", new TranscriptOffset(t.Input, stamp));
        _context.Offsets.Set($"{key}:out", new TranscriptOffset(t.Output, stamp));
        _context.Offsets.Set($"{key}:cr", new TranscriptOffset(t.CacheRead, stamp));
        _context.Offsets.Set($"{key}:cw", new TranscriptOffset(t.CacheWrite, stamp));
        _context.Offsets.Set($"{key}:cost", new TranscriptOffset(t.CostNano, stamp));
    }

    private sealed record Row(
        string Id, string? ParentId, string? Title, string? Directory, string? Model, double Cost,
        long Input, long Output, long Reasoning, long CacheRead, long CacheWrite, long Activity, string? Worktree);

    private readonly record struct Totals(long Input, long Output, long CacheRead, long CacheWrite, long CostNano)
    {
        public long Tokens => Input + Output + CacheRead + CacheWrite;

        public bool IsZero => Input == 0 && Output == 0 && CacheRead == 0 && CacheWrite == 0 && CostNano == 0;

        public bool Covers(Totals o) =>
            Input >= o.Input && Output >= o.Output && CacheRead >= o.CacheRead && CacheWrite >= o.CacheWrite && CostNano >= o.CostNano;

        public Totals Minus(Totals o) => new(Input - o.Input, Output - o.Output, CacheRead - o.CacheRead, CacheWrite - o.CacheWrite, CostNano - o.CostNano);
    }
}
