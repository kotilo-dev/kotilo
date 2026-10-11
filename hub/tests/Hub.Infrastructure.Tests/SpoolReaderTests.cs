using System.Text;
using Hub.Infrastructure.Hooks;

namespace Hub.Infrastructure.Tests;

public sealed class SpoolReaderTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Drains_in_chronological_order_and_deletes()
    {
        File.WriteAllText(_dir.File("0639264361898980360-2.json"), "b");
        File.WriteAllText(_dir.File("0639264361888927923-1.json"), "a");
        File.WriteAllText(_dir.File("0639264361900000000-3.tmp"), "partial");

        var items = SpoolReader.Drain(_dir.Path);

        items.Select(b => Encoding.UTF8.GetString(b)).Should().Equal("a", "b");
        Directory.EnumerateFiles(_dir.Path, "*.json").Should().BeEmpty();
        File.Exists(_dir.File("0639264361900000000-3.tmp")).Should().BeTrue("a fresh .tmp may still be in progress");
    }

    [Fact]
    public void Missing_directory_returns_nothing() =>
        SpoolReader.Drain(_dir.File("nope")).Should().BeEmpty();
}
