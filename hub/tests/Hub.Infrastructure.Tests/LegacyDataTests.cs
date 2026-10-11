using Hub.Core;

namespace Hub.Infrastructure.Tests;

/// <summary><see cref="LegacyData"/>: the hub's data folder move after a rename, always in a temp folder.</summary>
public sealed class LegacyDataTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Moves_the_legacy_folder_when_the_new_one_is_missing()
    {
        var legacy = Path.Combine(_dir.Path, "old-name", "hub");
        Directory.CreateDirectory(Path.Combine(legacy, "spool"));
        File.WriteAllText(Path.Combine(legacy, "hub.db"), "db");
        var target = Path.Combine(_dir.Path, "new-name", "hub");

        var result = LegacyData.MoveIfMissing(target, [Path.Combine(_dir.Path, "missing", "hub"), legacy]);

        result.State.Should().Be(LegacyMoveState.Moved);
        result.From.Should().Be(legacy);
        File.ReadAllText(Path.Combine(target, "hub.db")).Should().Be("db");
        Directory.Exists(Path.Combine(target, "spool")).Should().BeTrue();
        Directory.Exists(legacy).Should().BeFalse();
    }

    [Fact]
    public void Never_merges_into_an_existing_folder()
    {
        var legacy = Path.Combine(_dir.Path, "old-name", "hub");
        Directory.CreateDirectory(legacy);
        File.WriteAllText(Path.Combine(legacy, "hub.db"), "old");
        var target = Path.Combine(_dir.Path, "new-name", "hub");
        Directory.CreateDirectory(target);

        LegacyData.MoveIfMissing(target, [legacy]).Should().Be(LegacyMove.NotNeeded);

        File.Exists(Path.Combine(target, "hub.db")).Should().BeFalse();
        File.ReadAllText(Path.Combine(legacy, "hub.db")).Should().Be("old");
    }

    [Fact]
    public void Nothing_to_move_is_not_needed()
    {
        LegacyData.MoveIfMissing(Path.Combine(_dir.Path, "new-name", "hub"), []).Should().Be(LegacyMove.NotNeeded);
        LegacyData.MoveIfMissing(Path.Combine(_dir.Path, "new-name", "hub"), [Path.Combine(_dir.Path, "nope")]).Should().Be(LegacyMove.NotNeeded);
    }

    [Fact]
    public void A_brand_without_legacy_names_never_moves_anything()
    {
        var brand = Brand.Current with { LegacySlugs = [] };
        LegacyData.MigrateHubDataDir(new AppPaths(_dir.File("data"), _dir.File(".claude")), brand).Should().Be(LegacyMove.NotNeeded);
    }
}
