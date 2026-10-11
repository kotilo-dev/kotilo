using Dapper;

namespace Hub.Infrastructure.Data;

/// <summary>One finished dictation (spec §22.5). <see cref="Outputs"/> lists where it went, e.g. "type,file".</summary>
public sealed record DictationRecord(
    long Id,
    DateTimeOffset CreatedAt,
    TimeSpan Duration,
    string RawText,
    string FinalText,
    bool Cleaned,
    string? Mode,
    string? Model,
    string? Language,
    string? Outputs);

/// <summary><c>dictations</c>: history for "paste last" and the Dikte page.</summary>
public sealed class DictationRepository(Database db)
{
    /// <summary>Older rows are pruned on insert.</summary>
    public const int MaxRows = 500;

    private const string Columns =
        "id AS Id, created_at AS CreatedAt, duration_ms AS DurationMs, raw_text AS RawText, final_text AS FinalText, " +
        "cleaned AS Cleaned, mode AS Mode, model AS Model, language AS Language, outputs AS Outputs";

    public DictationRecord Add(DictationRecord record)
    {
        using var c = db.Open();
        using var tx = c.BeginTransaction();
        var id = c.ExecuteScalar<long>(
            """
            INSERT INTO dictations (created_at, duration_ms, raw_text, final_text, cleaned, mode, model, language, outputs)
            VALUES (@at, @ms, @RawText, @FinalText, @cleaned, @Mode, @Model, @Language, @Outputs);
            SELECT last_insert_rowid();
            """,
            new
            {
                at = record.CreatedAt.ToUnixTimeMilliseconds(),
                ms = (long)record.Duration.TotalMilliseconds,
                record.RawText,
                record.FinalText,
                cleaned = record.Cleaned ? 1 : 0,
                record.Mode,
                record.Model,
                record.Language,
                record.Outputs,
            },
            tx);
        c.Execute(
            "DELETE FROM dictations WHERE id NOT IN (SELECT id FROM dictations ORDER BY created_at DESC, id DESC LIMIT @max)",
            new { max = MaxRows },
            tx);
        tx.Commit();
        return record with { Id = id };
    }

    /// <summary>Newest first.</summary>
    public IReadOnlyList<DictationRecord> List(int limit = MaxRows)
    {
        using var c = db.Open();
        return c.Query<Row>($"SELECT {Columns} FROM dictations ORDER BY created_at DESC, id DESC LIMIT @limit", new { limit })
            .Select(r => r.ToModel())
            .ToList();
    }

    public DictationRecord? Latest() => List(1) is [var latest] ? latest : null;

    public void Delete(long id)
    {
        using var c = db.Open();
        c.Execute("DELETE FROM dictations WHERE id = @id", new { id });
    }

    public void Clear()
    {
        using var c = db.Open();
        c.Execute("DELETE FROM dictations");
    }

    private sealed class Row
    {
        public long Id { get; init; }

        public long CreatedAt { get; init; }

        public long DurationMs { get; init; }

        public string RawText { get; init; } = "";

        public string FinalText { get; init; } = "";

        public long Cleaned { get; init; }

        public string? Mode { get; init; }

        public string? Model { get; init; }

        public string? Language { get; init; }

        public string? Outputs { get; init; }

        public DictationRecord ToModel() => new(
            Id,
            DateTimeOffset.FromUnixTimeMilliseconds(CreatedAt),
            TimeSpan.FromMilliseconds(DurationMs),
            RawText,
            FinalText,
            Cleaned != 0,
            Mode,
            Model,
            Language,
            Outputs);
    }
}
