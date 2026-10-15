using Hub.Infrastructure.Data;

namespace Hub.Infrastructure.Tests;

/// <summary>Read offsets of deleted transcripts are removed; cursor keys and Droid field rows of existing files stay.</summary>
public sealed class TranscriptOffsetStoreTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Prune_removes_rows_of_missing_files_only()
    {
        var db = new Database(_dir.File("hub.db"));
        db.Migrate();
        var store = new TranscriptOffsetStore(db);
        var kept = _dir.File("kept.jsonl");
        var droid = _dir.File("droid.settings.json");
        File.WriteAllText(kept, "{}");
        File.WriteAllText(droid, "{}");
        var gone = _dir.File("gone.jsonl");
        var offset = new TranscriptOffset(10, DateTime.UtcNow);
        var noDrive = "QRSTUVWXYZ".Select(d => $"{d}:").First(d => !Directory.Exists(d + Path.DirectorySeparatorChar)) + gone[2..];
        foreach (var key in new[] { kept, gone, droid + "#input", gone + "#input", "db:" + gone, "opencode:ses_1:in", noDrive })
        {
            store.Set(key, offset);
        }

        var removed = store.PruneMissing();

        removed.Should().Be(2);
        store.GetAll().Keys.Should().BeEquivalentTo(kept, droid + "#input", "db:" + gone, "opencode:ses_1:in", noDrive);
    }
}
