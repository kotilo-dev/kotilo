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
