using Dapper;
using Hub.Infrastructure.Data;

namespace Hub.Infrastructure.Tests;

public sealed class BuddyMigrationTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Migration_010_drops_the_old_chat_list_and_its_index()
    {
        var db = new Database(_dir.File("hub.db"));
        db.Migrate();

        // A database at schema 9 still has the M5 table (004) with a row in it.
        using (var c = db.Open())
        {
            c.Execute("DELETE FROM schema_version WHERE version >= 10");
            c.Execute("CREATE TABLE IF NOT EXISTS buddy_chats (claude_session_id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT, pinned INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
            c.Execute("CREATE INDEX IF NOT EXISTS ix_buddy_chats_updated ON buddy_chats(pinned DESC, updated_at DESC)");
            c.Execute("INSERT INTO buddy_chats (claude_session_id, title, updated_at) VALUES ('s1', 'a title', 1)");
        }

        db.Migrate().Should().Be(10);

        using var check = db.Open();
        check.ExecuteScalar<long>("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '%buddy_chats%'").Should().Be(0);
    }
}
