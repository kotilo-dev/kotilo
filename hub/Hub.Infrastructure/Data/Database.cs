using System.Globalization;
using System.Reflection;
using Dapper;
using Microsoft.Data.Sqlite;

namespace Hub.Infrastructure.Data;

/// <summary>SQLite connection factory and ordered SQL migrations (spec §13).</summary>
public sealed class Database(string path)
{
    private const string MigrationPrefix = "Hub.Infrastructure.Migrations.";

    public string ConnectionString { get; } = new SqliteConnectionStringBuilder
    {
        DataSource = path,
        Mode = SqliteOpenMode.ReadWriteCreate,
        Cache = SqliteCacheMode.Private,
        Pooling = true,
    }.ToString();

    public SqliteConnection Open()
    {
        var connection = new SqliteConnection(ConnectionString);
        connection.Open();
        connection.Execute("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
        return connection;
    }

    /// <summary>Applies pending migrations. Returns the resulting schema version.</summary>
    public int Migrate()
    {
        using var connection = Open();
        connection.Execute("PRAGMA journal_mode = WAL;");
        connection.Execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL);");
        var current = connection.ExecuteScalar<long?>("SELECT MAX(version) FROM schema_version") ?? 0;

        foreach (var (version, sql) in LoadMigrations().Where(m => m.Version > current))
        {
            using var tx = connection.BeginTransaction();
            connection.Execute(sql, transaction: tx);
            connection.Execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (@version, @at)",
                new { version, at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() },
                tx);
            tx.Commit();
            current = version;
        }

        return (int)current;
    }

    private static IEnumerable<(int Version, string Sql)> LoadMigrations()
    {
        var assembly = typeof(Database).Assembly;
        return assembly.GetManifestResourceNames()
            .Where(n => n.StartsWith(MigrationPrefix, StringComparison.Ordinal) && n.EndsWith(".sql", StringComparison.Ordinal))
            .Select(n => (Version: ParseVersion(n), Sql: Read(assembly, n)))
            .OrderBy(m => m.Version);
    }

    private static int ParseVersion(string resourceName)
    {
        // "Hub.Infrastructure.Migrations._001_initial.sql" or "...Migrations.001_initial.sql"
        var file = resourceName[MigrationPrefix.Length..].TrimStart('_');
        return int.Parse(file[..file.IndexOf('_', StringComparison.Ordinal)], CultureInfo.InvariantCulture);
    }

    private static string Read(Assembly assembly, string name)
    {
        using var stream = assembly.GetManifestResourceStream(name)!;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
