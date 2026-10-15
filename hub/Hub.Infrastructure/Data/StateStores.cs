using Hub.Core.Notifications;
using Dapper;

namespace Hub.Infrastructure.Data;

public sealed record TranscriptOffset(long Offset, DateTime LastWriteUtc);

/// <summary><c>transcript_offsets</c>: how far each transcript has been read (spec §7.1).</summary>
public sealed class TranscriptOffsetStore(Database db)
{
    public TranscriptOffset? Get(string path)
    {
        using var c = db.Open();
        var row = c.QueryFirstOrDefault<(long Offset, long LastWrite)?>(
            "SELECT offset, last_write_utc FROM transcript_offsets WHERE path = @path", new { path });
        return row is { } r ? new TranscriptOffset(r.Offset, new DateTime(r.LastWrite, DateTimeKind.Utc)) : null;
    }

    public IReadOnlyDictionary<string, TranscriptOffset> GetAll()
    {
        using var c = db.Open();
        return c.Query<(string Path, long Offset, long LastWrite)>("SELECT path, offset, last_write_utc FROM transcript_offsets")
            .ToDictionary(r => r.Path, r => new TranscriptOffset(r.Offset, new DateTime(r.LastWrite, DateTimeKind.Utc)), StringComparer.OrdinalIgnoreCase);
    }

    public void Set(string path, TranscriptOffset offset)
    {
        using var c = db.Open();
        c.Execute(
            """
            INSERT INTO transcript_offsets (path, offset, last_write_utc) VALUES (@path, @offset, @lastWrite)
            ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, last_write_utc = excluded.last_write_utc
            """,
            new { path, offset = offset.Offset, lastWrite = offset.LastWriteUtc.Ticks });
    }

    /// <summary>
    /// Removes the rows of files that no longer exist. Only keys that are full paths count (Droid's <c>path#field</c> rows
    /// follow their file; <c>db:</c> and other cursor keys are kept), and nothing is removed while the drive is missing.
    /// </summary>
    /// <returns>The rows removed.</returns>
    public int PruneMissing()
    {
        using var c = db.Open();
        var missing = c.Query<string>("SELECT path FROM transcript_offsets").Where(IsMissingFile).ToList();
        if (missing.Count == 0)
        {
            return 0;
        }

        using var tx = c.BeginTransaction();
        var removed = missing.Sum(path => c.Execute("DELETE FROM transcript_offsets WHERE path = @path", new { path }, tx));
        tx.Commit();
        return removed;
    }

    internal static bool IsMissingFile(string key)
    {
        if (!IsGoneFile(key))
        {
            return false;
        }

        var hash = key.LastIndexOf('#');
        return hash < 0 || IsGoneFile(key[..hash]);
    }

    private static bool IsGoneFile(string path)
    {
        try
        {
            return Path.IsPathFullyQualified(path)
                && Path.GetPathRoot(path) is { Length: > 0 } root && Directory.Exists(root)
                && !File.Exists(path);
        }
        catch (ArgumentException)
        {
            return false;
        }
    }
}

/// <summary><c>notification_log</c> as the persisted hysteresis / once-per-period state (spec §13).</summary>
public sealed class NotificationLogStore(Database db) : IRuleStateStore
{
    public bool HasFired(string ruleId, string key)
    {
        using var c = db.Open();
        return c.ExecuteScalar<long>("SELECT COUNT(*) FROM notification_log WHERE rule_id = @ruleId AND key = @key", new { ruleId, key }) > 0;
    }

    public void MarkFired(string ruleId, string key, DateTimeOffset at)
    {
        using var c = db.Open();
        c.Execute(
            "INSERT INTO notification_log (rule_id, key, fired_at) VALUES (@ruleId, @key, @at)",
            new { ruleId, key, at = at.ToUnixTimeMilliseconds() });
    }

    public void Clear(string ruleId, string key)
    {
        using var c = db.Open();
        c.Execute("DELETE FROM notification_log WHERE rule_id = @ruleId AND key = @key", new { ruleId, key });
    }

    public int Prune(DateTimeOffset olderThan)
    {
        using var c = db.Open();
        return c.Execute("DELETE FROM notification_log WHERE fired_at < @cutoff", new { cutoff = olderThan.ToUnixTimeMilliseconds() });
    }
}
