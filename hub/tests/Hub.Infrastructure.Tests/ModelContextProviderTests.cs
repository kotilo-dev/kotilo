using Hub.Core.Sessions;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Tests;

/// <summary>The shipped <c>models.json</c> defaults and how they combine with the user's copy.</summary>
public sealed class ModelContextProviderTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Theory]
    [InlineData("claude-fable-5", 1_000_000)]
    [InlineData("claude-fable-5-1", 1_000_000)]
    [InlineData("claude-sonnet-5", 1_000_000)]
    [InlineData("claude-haiku-5-5", 1_000_000)]
    [InlineData("claude-opus-4-7", 1_000_000)]
    [InlineData("claude-opus-4-8", 1_000_000)]
    [InlineData("claude-opus-5", 1_000_000)]
    [InlineData("claude-opus-4-6", 200_000)]
    [InlineData("claude-sonnet-4-6", 200_000)]
    [InlineData("claude-sonnet-4-5-20250929", 200_000)]
    [InlineData("claude-haiku-4-5", 200_000)]
    [InlineData("claude-opus-4-20250514", 200_000)]
    public void Default_table_knows_the_1M_families(string model, long window)
    {
        ModelContextTable.Parse(ModelContextProvider.DefaultJson()).WindowFor(model).Should().Be(window);
    }

    [Fact]
    public void Default_1M_model_reads_against_1M()
    {
        var table = ModelContextTable.Parse(ModelContextProvider.DefaultJson());
        ContextUsageResolver.FromTokens(150_000, "claude-opus-4-7", table).Should().Be(15);
        ContextUsageResolver.FromTokens(150_000, "claude-opus-4-6", table).Should().Be(75);
        ContextUsageResolver.FromTokens(500_000, "claude-opus-4-6", table).Should().Be(50, "[1m] sessions are bumped above 200k");
    }

    [Fact]
    public void Older_user_copy_does_not_hide_new_defaults_but_user_entries_win()
    {
        var path = _dir.File("models.json");
        File.WriteAllText(path, """{ "models": { "claude-": 200000, "claude-opus-4-8": 400000, "local-": 32000 } }""");
        var provider = new ModelContextProvider(path);

        provider.Load().Should().BeTrue();

        provider.Current.WindowFor("claude-opus-4-7").Should().Be(1_000_000, "new default entry");
        provider.Current.WindowFor("claude-opus-4-8").Should().Be(400_000, "the user's value wins");
        provider.Current.WindowFor("local-model").Should().Be(32_000);
        provider.Current.WindowFor("claude-opus-4-6").Should().Be(200_000);
    }

    [Fact]
    public void First_run_writes_the_default_file()
    {
        var path = _dir.File("models.json");
        new ModelContextProvider(path).Load().Should().BeTrue();
        File.ReadAllText(path).Should().Be(ModelContextProvider.DefaultJson());
    }
}
