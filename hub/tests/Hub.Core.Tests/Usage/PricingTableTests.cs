using Hub.Core.Usage;

namespace Hub.Core.Tests.Usage;

public class PricingTableTests
{
    private static readonly PricingTable Table = PricingTable.Parse("""
        {
          // comment allowed
          "models": {
            "claude-opus-5":       { "input": 5, "output": 25, "cacheWrite5m": 6.25, "cacheWrite1h": 10, "cacheRead": 0.5 },
            "claude-opus-5-5":     { "input": 4, "output": 20, "cacheWrite5m": 5, "cacheWrite1h": 8, "cacheRead": 0.2 },
            "claude-opus-5-5-fast":{ "input": 8, "output": 40, "cacheWrite5m": 10, "cacheWrite1h": 16, "cacheRead": 0.4 },
            "claude-haiku-4-5":    { "input": 1, "output": 5, "cacheWrite5m": 1.25, "cacheWrite1h": 2, "cacheRead": 0.1, "contextWindow": 200000 },
          }
        }
        """);

    [Theory]
    [InlineData("claude-opus-5-5", 4)]
    [InlineData("claude-opus-5", 5)]
    [InlineData("claude-opus-5-20260101", 5)]
    [InlineData("claude-haiku-4-5-20251001", 1)]
    public void Longest_prefix_wins(string model, decimal input) =>
        Table.Find(model)!.Input.Should().Be(input);

    [Theory]
    [InlineData("gpt-4")]
    [InlineData("claude-opus-4-1")]
    [InlineData("")]
    [InlineData(null)]
    public void Unknown_model_has_no_price(string? model) => Table.Find(model).Should().BeNull();

    [Fact]
    public void Fast_mode_uses_fast_entry_and_never_standard_rates()
    {
        Table.Find("claude-opus-5-5", fast: true)!.Output.Should().Be(40);
        Table.Find("claude-opus-5-5-20260601", fast: true)!.Output.Should().Be(40);
        Table.Find("claude-haiku-4-5", fast: true).Should().BeNull();
        Table.Find("claude-opus-5-5")!.Output.Should().Be(20, "standard lookup ignores -fast keys");
    }

    [Fact]
    public void Cost_uses_each_token_type_rate()
    {
        var e = new UsageEntry("k", DateTimeOffset.UnixEpoch, Input: 1_000_000, Output: 1_000_000,
            CacheCreate5m: 1_000_000, CacheCreate1h: 1_000_000, CacheRead: 1_000_000) { Model = "claude-opus-5-5" };

        Table.Cost(e).Should().Be(4 + 20 + 5 + 8 + 0.2m);
        Table.Cost(e with { IsFast = true }).Should().Be(8 + 40 + 10 + 16 + 0.4m);
    }

    [Fact]
    public void Unpriced_cost_is_null_and_synthetic_is_free()
    {
        var e = new UsageEntry("k", DateTimeOffset.UnixEpoch, 100, 100, 0, 0, 0);
        Table.Cost(e with { Model = "mystery" }).Should().BeNull();
        Table.Cost(e with { Model = UsageEntry.SyntheticModel }).Should().Be(0);
    }

    [Fact]
    public void Context_window_is_optional()
    {
        Table.Find("claude-haiku-4-5")!.ContextWindow.Should().Be(200_000);
        Table.Find("claude-opus-5-5")!.ContextWindow.Should().BeNull();
    }

    [Fact]
    public void Default_pricing_file_parses()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "pricing.default.json");
        var table = PricingTable.Parse(File.ReadAllText(path));

        table.Find("claude-opus-5-5")!.Input.Should().Be(4);
        table.Find("claude-haiku-4-5-20251001")!.Output.Should().Be(5);
        table.Models.Should().HaveCountGreaterThan(5);
    }
}
