using Dapper;

namespace Hub.Infrastructure.Data;

/// <summary>A row of <c>projects</c> (spec §13).</summary>
public sealed record ProjectRecord(string Root, string? Alias, bool Hidden, bool Manual, DateTimeOffset DiscoveredAt);

/// <summary>
/// <c>projects</c> plus activity queries for discovery (spec §8.1): every project root seen in sessions or usage since a
/// cut-off, with its latest activity.
/// </summary>
public sealed class ProjectRepository(Database db)
{
    public IReadOnlyList<ProjectRecord> LoadAll()
    {
        using var c = db.Open();
        return c.Query<(string Root, string? Alias, long Hidden, long Manual, long DiscoveredAt)>(
                "SELECT root, alias, hidden, manual, discovered_at FROM projects")
            .Select(r => new ProjectRecord(r.Root, r.Alias, r.Hidden != 0, r.Manual != 0, DateTimeOffset.FromUnixTimeMilliseconds(r.DiscoveredAt)))
            .ToList();
    }

    /// <summary>Latest activity per raw project root (as stored; callers normalize) since <paramref name="since"/>.</summary>
    public IReadOnlyDictionary<string, DateTimeOffset> Activity(DateTimeOffset since)
    {
        using var c = db.Open();
        var rows = c.Query<(string Root, long At)>(
            """
            SELECT project_root, MAX(at) FROM (
                SELECT project_root, MAX(ts) AS at FROM usage_entries
                WHERE ts >= @since AND project_root IS NOT NULL AND project_root <> '' GROUP BY project_root
                UNION ALL
                SELECT project_root, MAX(last_event_at) AS at FROM sessions
                WHERE last_event_at >= @since AND project_root <> '' GROUP BY project_root
            ) GROUP BY project_root
            """,
            new { since = since.ToUnixTimeMilliseconds() });
        return rows.ToDictionary(r => r.Root, r => DateTimeOffset.FromUnixTimeMilliseconds(r.At), StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>Records newly discovered roots; existing rows (and their flags) are kept.</summary>
    public void EnsureDiscovered(IEnumerable<string> roots, DateTimeOffset now)
    {
        using var c = db.Open();
        using var tx = c.BeginTransaction();
        foreach (var root in roots)
        {
            c.Execute(
                "INSERT OR IGNORE INTO projects (root, discovered_at) VALUES (@root, @at)",
                new { root, at = now.ToUnixTimeMilliseconds() },
                tx);
        }

        tx.Commit();
    }

    /// <summary>Adds a folder by hand; re-adding a hidden project un-hides it.</summary>
    public void AddManual(string root, DateTimeOffset now)
    {
        using var c = db.Open();
        c.Execute(
            """
            INSERT INTO projects (root, discovered_at, manual) VALUES (@root, @at, 1)
            ON CONFLICT(root) DO UPDATE SET manual = 1, hidden = 0
            """,
            new { root, at = now.ToUnixTimeMilliseconds() });
    }

    /// <summary>Display name override; null or blank clears it.</summary>
    public void SetAlias(string root, string? alias, DateTimeOffset now)
    {
        using var c = db.Open();
        c.Execute(
            """
            INSERT INTO projects (root, discovered_at, alias) VALUES (@root, @at, @alias)
            ON CONFLICT(root) DO UPDATE SET alias = @alias
            """,
            new { root, at = now.ToUnixTimeMilliseconds(), alias = string.IsNullOrWhiteSpace(alias) ? null : alias.Trim() });
    }

    public void SetHidden(string root, bool hidden, DateTimeOffset now)
    {
        using var c = db.Open();
        c.Execute(
            """
            INSERT INTO projects (root, discovered_at, hidden) VALUES (@root, @at, @hidden)
            ON CONFLICT(root) DO UPDATE SET hidden = @hidden
            """,
            new { root, at = now.ToUnixTimeMilliseconds(), hidden = hidden ? 1 : 0 });
    }
}
