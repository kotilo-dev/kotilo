using Hub.Core.Usage;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Projects;

namespace Hub.Infrastructure.Usage;

/// <summary>What every usage source shares: read offsets, the usage table, the price table and the project-root resolver.</summary>
public sealed record UsageSourceContext(TranscriptOffsetStore Offsets, UsageRepository Repository, Func<PricingTable> Pricing, ProjectRootResolver? Roots)
{
    /// <summary>
    /// Stamps <paramref name="agent"/>, prices entries that carry no cost of their own, resolves project roots and upserts.
    /// Returns the rows written.
    /// </summary>
    public int Store(IEnumerable<UsageEntry> entries, string agent)
    {
        var table = Pricing();
        var rows = entries.Select(e => e with
        {
            Agent = agent,
            CostUsd = e.CostReported ? e.CostUsd : table.Cost(e),
            ProjectRoot = Roots?.Resolve(e.ProjectRoot) ?? e.ProjectRoot,
        }).ToList();
        return Repository.Upsert(rows);
    }
}

/// <summary>
/// One agent's token usage on disk (ARCHITECTURE §3 <c>IUsageSource</c>): reads incrementally, stores
/// <see cref="UsageEntry"/> rows through <see cref="UsageRepository"/>. Passes are serialized by the usage worker.
/// </summary>
public interface IUsageSource
{
    /// <summary>Adapter id stamped on every entry and plan limit this source reads.</summary>
    string Agent { get; }

    /// <summary>Reads everything new written since <paramref name="since"/> (backfill and the periodic sweep / poll).</summary>
    ScanResult ScanAll(DateTime since);
}

/// <summary>Append-only files (JSONL transcripts, rollouts): watched, and re-read from the stored offset when they change.</summary>
public interface IFileUsageSource : IUsageSource
{
    /// <summary>Folders to watch recursively; missing ones are skipped (the 60 s sweep still covers them once they exist).</summary>
    IReadOnlyList<string> WatchDirs { get; }

    /// <summary>File name pattern for the watcher (<c>*.jsonl</c>).</summary>
    string FilePattern { get; }

    /// <summary>A write to one of these files counts as agent activity for the "hooks silent" health check (Claude only).</summary>
    bool ReportsActivity { get; }

    /// <summary>True when <paramref name="path"/> is one of this source's files.</summary>
    bool Owns(string path);

    ScanResult ScanFile(string path);
}

/// <summary>A store that can't be watched file by file (OpenCode's SQLite DB): polled every <see cref="PollInterval"/>.</summary>
public interface IPollingUsageSource : IUsageSource
{
    TimeSpan PollInterval { get; }
}

/// <summary>
/// Base for a database usage source: skips a pass when neither the DB nor its WAL changed, keeps a numeric cursor
/// (e.g. the newest <c>time_updated</c> read) in <see cref="TranscriptOffsetStore"/> under <c>db:&lt;path&gt;</c>, and stores
/// what <see cref="ReadSince"/> returns. Implementations open the DB read-only and select named columns only.
/// </summary>
public abstract class DbPollingUsageSource(string agent, string databasePath, UsageSourceContext context, TimeSpan pollInterval) : IPollingUsageSource
{
    public string Agent => agent;

    public string DatabasePath => databasePath;

    public TimeSpan PollInterval => pollInterval;

    public ScanResult ScanAll(DateTime since)
    {
        DateTime lastWrite;
        try
        {
            if (!File.Exists(databasePath))
            {
                return ScanResult.Empty;
            }

            lastWrite = LastWrite(databasePath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return ScanResult.Empty;
        }

        var key = "db:" + databasePath;
        var stored = context.Offsets.Get(key);
        if (stored is not null && stored.LastWriteUtc == lastWrite)
        {
            return ScanResult.Empty;
        }

        var floor = new DateTimeOffset(DateTime.SpecifyKind(since, DateTimeKind.Utc)).ToUnixTimeMilliseconds();
        var (entries, cursor) = ReadSince(Math.Max(stored?.Offset ?? 0, floor));
        var written = context.Store(entries, agent);
        context.Offsets.Set(key, new TranscriptOffset(cursor, lastWrite));
        return new ScanResult(1, entries.Count, written, 0, 0);
    }

    /// <summary>Entries changed after <paramref name="cursor"/>, and the cursor to continue from next time.</summary>
    protected abstract (IReadOnlyList<UsageEntry> Entries, long Cursor) ReadSince(long cursor);

    private static DateTime LastWrite(string path)
    {
        var db = File.GetLastWriteTimeUtc(path);
        var wal = path + "-wal";
        return File.Exists(wal) && File.GetLastWriteTimeUtc(wal) > db ? File.GetLastWriteTimeUtc(wal) : db;
    }
}
