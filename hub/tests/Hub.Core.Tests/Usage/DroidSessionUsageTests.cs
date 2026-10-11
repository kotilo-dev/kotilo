using Hub.Core.Adapters;
using Hub.Core.Usage;

namespace Hub.Core.Tests.Usage;

public class DroidSessionUsageTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 5, 9, 13, 25, TimeSpan.Zero);

    [Fact]
    public void Parses_model_and_running_totals_from_the_fixture()
    {
        var (model, totals) = DroidSessionUsage.Parse(Fixtures.Read("droid/settings.json"))!.Value;

        model.Should().Be("claude-sonnet-4-5-20250929");
        totals.Should().Be(new DroidTokenTotals(48210, 3120, 12000, 96400, 850));
    }

    [Theory]
    [InlineData("""{"model":"m"}""")]
    [InlineData("""{"tokenUsage":"lots"}""")]
    [InlineData("""{"tokenUsage":{"inputTokens":1""")]
    [InlineData("not json")]
    public void A_file_without_usable_token_usage_reads_as_nothing(string json)
    {
        DroidSessionUsage.Parse(json).Should().BeNull();
    }

    [Fact]
    public void Missing_or_negative_counters_read_as_zero()
    {
        var (model, totals) = DroidSessionUsage.Parse("""{"tokenUsage":{"inputTokens":10,"outputTokens":-4}}""")!.Value;

        model.Should().BeNull();
        totals.Should().Be(new DroidTokenTotals(10, 0, 0, 0, 0));
    }

    [Fact]
    public void Delta_is_the_growth_since_the_last_totals()
    {
        var first = new DroidTokenTotals(100, 10, 5, 50, 2);
        var second = new DroidTokenTotals(160, 25, 5, 90, 2);

        DroidSessionUsage.Delta(null, first).Should().Be(first, "the first sighting counts everything");
        DroidSessionUsage.Delta(first, second).Should().Be(new DroidTokenTotals(60, 15, 0, 40, 0));
        DroidSessionUsage.Delta(second, second).Should().BeNull("nothing new");
        DroidSessionUsage.Delta(null, new DroidTokenTotals(0, 0, 0, 0, 0)).Should().BeNull();
    }

    [Fact]
    public void A_counter_that_went_down_means_a_reset()
    {
        var before = new DroidTokenTotals(500, 50, 0, 0, 0);
        var after = new DroidTokenTotals(30, 60, 0, 0, 0);

        DroidSessionUsage.Delta(before, after).Should().Be(after);
    }

    [Fact]
    public void Entry_carries_the_session_model_and_a_key_that_repeats_for_the_same_state()
    {
        var current = new DroidTokenTotals(160, 25, 5, 90, 2);
        var delta = new DroidTokenTotals(60, 15, 0, 40, 0);

        var e = DroidSessionUsage.Entry("s1", "custom:glm-5.1", delta, current, T0, @"C:\src\demo");

        e.DedupKey.Should().Be("droid:s1:282");
        e.Agent.Should().Be(AgentIds.Droid);
        (e.Input, e.Output, e.CacheCreate5m, e.CacheCreate1h, e.CacheRead).Should().Be((60L, 15L, 0L, 0L, 40L));
        e.Model.Should().Be("custom:glm-5.1");
        e.SessionId.Should().Be("s1");
        e.ProjectRoot.Should().Be(@"C:\src\demo");
        e.Timestamp.Should().Be(T0);
        DroidSessionUsage.Entry("s1", null, delta, current, T0.AddHours(1), null).DedupKey.Should().Be(e.DedupKey);
    }

    [Theory]
    [InlineData(@"C:\Users\dev\.factory\sessions\-C-Users-dev-src-demo\7f3c.settings.json", "7f3c")]
    [InlineData(@"C:\Users\dev\.factory\sessions\-x\7f3c.jsonl", null)]
    [InlineData(@"C:\Users\dev\.factory\settings.json", null)]
    [InlineData(@"C:\x\.settings.json", null)]
    public void Session_id_comes_from_the_file_name(string path, string? expected)
    {
        DroidSessionUsage.SessionIdFromFileName(path).Should().Be(expected);
    }

    [Theory]
    [InlineData("""{"type":"session_start","id":"7f3c","title":"Fix failing tests","cwd":"C:\\Users\\dev\\src\\demo"}""", @"C:\Users\dev\src\demo")]
    [InlineData("""{"type":"message","id":"m1","cwd":"C:\\x"}""", null)]
    [InlineData("""{"type":"session_start"}""", null)]
    [InlineData("{", null)]
    public void Cwd_comes_only_from_a_session_start_record(string line, string? expected)
    {
        DroidSessionUsage.CwdFromSessionStart(line).Should().Be(expected);
    }
}
