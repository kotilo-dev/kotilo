using System.Security.Cryptography;
using System.Text;
using Hub.Core.Insights;
using Dapper;

namespace Hub.Infrastructure.Data;

/// <summary><c>customers</c> and <c>projects.customer_id</c> (spec §18.2).</summary>
public sealed class CustomerRepository(Database db)
{
    public IReadOnlyList<Customer> LoadAll()
    {
        using var c = db.Open();
        return c.Query<(long Id, string Name, string Color, long Archived)>("SELECT id, name, color, archived FROM customers ORDER BY name COLLATE NOCASE")
            .Select(r => new Customer(r.Id, r.Name, r.Color, r.Archived != 0))
            .ToList();
    }

    public Customer Add(string name, string color)
    {
        using var c = db.Open();
        var id = c.ExecuteScalar<long>(
            "INSERT INTO customers (name, color) VALUES (@name, @color); SELECT last_insert_rowid();",
            new { name = name.Trim(), color });
        return new Customer(id, name.Trim(), color);
    }

    public void Update(Customer customer)
    {
        using var c = db.Open();
        c.Execute(
            "UPDATE customers SET name = @Name, color = @Color, archived = @archived WHERE id = @Id",
            new { customer.Name, customer.Color, customer.Id, archived = customer.Archived ? 1 : 0 });
    }

    /// <summary>Deletes the customer; its projects become unassigned.</summary>
    public void Delete(long id)
    {
        using var c = db.Open();
        using var tx = c.BeginTransaction();
        c.Execute("UPDATE projects SET customer_id = NULL WHERE customer_id = @id", new { id }, tx);
        c.Execute("DELETE FROM customers WHERE id = @id", new { id }, tx);
        tx.Commit();
    }

    /// <summary>Project root → customer id for every labelled project.</summary>
    public IReadOnlyDictionary<string, long> Assignments()
    {
        using var c = db.Open();
        return c.Query<(string Root, long CustomerId)>("SELECT root, customer_id FROM projects WHERE customer_id IS NOT NULL")
            .ToDictionary(r => r.Root, r => r.CustomerId, StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>Labels (or with null, unlabels) a project.</summary>
    public void Assign(string root, long? customerId, DateTimeOffset now)
    {
        using var c = db.Open();
        c.Execute(
            """
            INSERT INTO projects (root, discovered_at, customer_id) VALUES (@root, @at, @customerId)
            ON CONFLICT(root) DO UPDATE SET customer_id = @customerId
            """,
            new { root, at = now.ToUnixTimeMilliseconds(), customerId });
    }
}

/// <summary><c>git_status</c> (spec §18.3).</summary>
public sealed class GitStatusRepository(Database db)
{
    public IReadOnlyDictionary<string, GitStatus> LoadAll()
    {
        using var c = db.Open();
        return c.Query<Row>(
                """
                SELECT project_root AS Root, branch AS Branch, detached AS Detached, has_upstream AS HasUpstream, ahead AS Ahead,
                       behind AS Behind, changed AS Changed, last_commit_at AS LastCommitAt,
                       last_commit_subject AS LastCommitSubject, checked_at AS CheckedAt
                FROM git_status
                """)
            .ToDictionary(r => r.Root, r => r.ToModel(), StringComparer.OrdinalIgnoreCase);
    }

    public void Save(string root, GitStatus s)
    {
        using var c = db.Open();
        c.Execute(
            """
            INSERT INTO git_status (project_root, branch, detached, has_upstream, ahead, behind, changed, last_commit_at, last_commit_subject, checked_at)
            VALUES (@root, @Branch, @detached, @upstream, @Ahead, @Behind, @Changed, @lastCommit, @LastCommitSubject, @checkedAt)
            ON CONFLICT(project_root) DO UPDATE SET branch = excluded.branch, detached = excluded.detached,
                has_upstream = excluded.has_upstream, ahead = excluded.ahead, behind = excluded.behind, changed = excluded.changed,
                last_commit_at = excluded.last_commit_at, last_commit_subject = excluded.last_commit_subject, checked_at = excluded.checked_at
            """,
            new
            {
                root,
                s.Branch,
                detached = s.IsDetached ? 1 : 0,
                upstream = s.HasUpstream ? 1 : 0,
                s.Ahead,
                s.Behind,
                s.Changed,
                lastCommit = s.LastCommitAt?.ToUnixTimeMilliseconds(),
                s.LastCommitSubject,
                checkedAt = s.CheckedAt.ToUnixTimeMilliseconds(),
            });
    }

    private sealed class Row
    {
        public string Root { get; set; } = "";

        public string? Branch { get; set; }

        public long Detached { get; set; }

        public long HasUpstream { get; set; }

        public long Ahead { get; set; }

        public long Behind { get; set; }

        public long Changed { get; set; }

        public long? LastCommitAt { get; set; }

        public string? LastCommitSubject { get; set; }

        public long CheckedAt { get; set; }

        public GitStatus ToModel() => new(
            Branch, Detached != 0, HasUpstream != 0, (int)Ahead, (int)Behind, (int)Changed,
            LastCommitAt is { } at ? DateTimeOffset.FromUnixTimeMilliseconds(at) : null,
            LastCommitSubject,
            DateTimeOffset.FromUnixTimeMilliseconds(CheckedAt));
    }
}

/// <summary>
/// <c>todo_snapshots</c> (spec §18.7): one row per item state change, so the day's completed items can be found.
/// Item identity is a hash of file + heading + text; the text itself is the user's own todo line.
/// </summary>
public sealed class TodoSnapshotRepository(Database db)
{
    public static string ItemHash(string group, string text) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(group + "\u001f" + text.Trim())))[..24];

    /// <summary>Stores items whose state differs from their latest stored state. Returns rows written.</summary>
    public int Record(string root, string file, IEnumerable<(string Hash, string Text, bool Done)> items, DateTimeOffset seenAt)
    {
        using var c = db.Open();
        using var tx = c.BeginTransaction();
        var latest = c.Query<(string Hash, string State)>(
                """
                SELECT item_hash, state FROM todo_snapshots s
                WHERE project_root = @root AND file = @file
                  AND id = (SELECT MAX(id) FROM todo_snapshots x WHERE x.project_root = s.project_root AND x.file = s.file AND x.item_hash = s.item_hash)
                """,
                new { root, file }, tx)
            .ToDictionary(r => r.Hash, r => r.State, StringComparer.Ordinal);

        var written = 0;
        foreach (var (hash, text, done) in items)
        {
            var state = done ? "done" : "open";
            if (latest.TryGetValue(hash, out var known) && known == state)
            {
                continue;
            }

            c.Execute(
                "INSERT INTO todo_snapshots (project_root, file, item_hash, text, state, seen_at) VALUES (@root, @file, @hash, @text, @state, @at)",
                new { root, file, hash, text, state, at = seenAt.ToUnixTimeMilliseconds() },
                tx);
            latest[hash] = state;
            written++;
        }

        tx.Commit();
        return written;
    }

    /// <summary>Snapshots of items that changed in [from, to), together with each one's earlier history.</summary>
    public IReadOnlyList<TodoSnapshot> Around(DateTimeOffset from, DateTimeOffset to)
    {
        using var c = db.Open();
        return c.Query<(string Root, string File, string Hash, string Text, string State, long SeenAt)>(
                """
                SELECT s.project_root, s.file, s.item_hash, s.text, s.state, s.seen_at FROM todo_snapshots s
                WHERE s.seen_at < @to AND EXISTS (
                    SELECT 1 FROM todo_snapshots r WHERE r.project_root = s.project_root AND r.file = s.file
                      AND r.item_hash = s.item_hash AND r.seen_at >= @from AND r.seen_at < @to)
                """,
                new { from = from.ToUnixTimeMilliseconds(), to = to.ToUnixTimeMilliseconds() })
            .Select(r => new TodoSnapshot(r.Root, r.File, r.Hash, r.Text, r.State == "done", DateTimeOffset.FromUnixTimeMilliseconds(r.SeenAt)))
            .ToList();
    }

    public int Prune(DateTimeOffset olderThan)
    {
        using var c = db.Open();

        // Keep each item's latest row so its current state stays known.
        return c.Execute(
            """
            DELETE FROM todo_snapshots WHERE seen_at < @cutoff
              AND id <> (SELECT MAX(id) FROM todo_snapshots x WHERE x.project_root = todo_snapshots.project_root
                         AND x.file = todo_snapshots.file AND x.item_hash = todo_snapshots.item_hash)
            """,
            new { cutoff = olderThan.ToUnixTimeMilliseconds() });
    }
}

/// <summary>A stored daily summary (spec §18.7).</summary>
public sealed record DailySummaryRecord(DateOnly Date, string Markdown, string? Model, DateTimeOffset GeneratedAt, string SourceHash);

public sealed class DailySummaryRepository(Database db)
{
    public DailySummaryRecord? Get(DateOnly date)
    {
        using var c = db.Open();
        var r = c.QueryFirstOrDefault<(string Date, string Markdown, string? Model, long GeneratedAt, string SourceHash)?>(
            "SELECT date, markdown, model, generated_at, source_hash FROM daily_summaries WHERE date = @date",
            new { date = date.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) });
        return r is { } row
            ? new DailySummaryRecord(date, row.Markdown, row.Model, DateTimeOffset.FromUnixTimeMilliseconds(row.GeneratedAt), row.SourceHash)
            : null;
    }

    /// <summary>Newest first; the markdown is included (it is the user's own generated summary, not a transcript).</summary>
    public IReadOnlyList<DailySummaryRecord> List(int limit)
    {
        using var c = db.Open();
        return c.Query<(string Date, string Markdown, string? Model, long GeneratedAt, string SourceHash)>(
                "SELECT date, markdown, model, generated_at, source_hash FROM daily_summaries ORDER BY date DESC LIMIT @limit",
                new { limit })
            .Select(r => new DailySummaryRecord(
                DateOnly.ParseExact(r.Date, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
                r.Markdown,
                r.Model,
                DateTimeOffset.FromUnixTimeMilliseconds(r.GeneratedAt),
                r.SourceHash))
            .ToList();
    }

    public void Save(DailySummaryRecord s)
    {
        using var c = db.Open();
        c.Execute(
            """
            INSERT INTO daily_summaries (date, markdown, model, generated_at, source_hash) VALUES (@date, @Markdown, @Model, @at, @SourceHash)
            ON CONFLICT(date) DO UPDATE SET markdown = excluded.markdown, model = excluded.model,
                generated_at = excluded.generated_at, source_hash = excluded.source_hash
            """,
            new
            {
                date = s.Date.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
                s.Markdown,
                s.Model,
                at = s.GeneratedAt.ToUnixTimeMilliseconds(),
                s.SourceHash,
            });
    }
}
