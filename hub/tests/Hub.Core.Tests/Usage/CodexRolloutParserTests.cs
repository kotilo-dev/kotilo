using System.Text;
using Hub.Core.Adapters;
using Hub.Core.Usage;

namespace Hub.Core.Tests.Usage;

public class CodexRolloutParserTests
{
    private static (List<UsageEntry> Entries, List<PlanLimits> Limits, CodexRolloutState State) ParseFixture()
    {
        var state = new CodexRolloutState();
        var entries = new List<UsageEntry>();
        var limits = new List<PlanLimits>();
        foreach (var line in Fixtures.Read("codex/rollout.jsonl").Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var (entry, l) = CodexRolloutParser.ParseLine(Encoding.UTF8.GetBytes(line), state);
            if (entry is not null)
            {
                entries.Add(entry);
            }

            if (l is not null)
            {
                limits.Add(l);
            }
        }

        return (entries, limits, state);
    }

    [Fact]
    public void Session_meta_and_turn_context_fill_the_state()
    {
        var (_, _, state) = ParseFixture();

        state.SessionId.Should().Be("0199a1b2-0000-7000-8000-000000000001");
        state.Cwd.Should().Be(@"C:\src\beta");
        state.Model.Should().Be("gpt-test-codex");
    }

    [Fact]
    public void Token_counts_become_per_response_entries_with_cached_input_split_out()
    {
        var (entries, _, _) = ParseFixture();

        entries.Should().HaveCount(3, "the repeated token_count reuses the same dedup key");
        entries.Select(e => e.DedupKey).Distinct().Should().HaveCount(2);
        var first = entries[0];
        first.Agent.Should().Be(AgentIds.Codex);
        first.Input.Should().Be(1000);
        first.CacheRead.Should().Be(3000);
        first.Output.Should().Be(200);
        first.Model.Should().Be("gpt-test-codex");
        first.ProjectRoot.Should().Be(@"C:\src\beta");
        first.CostUsd.Should().BeNull("Codex prices are not known");
        entries[2].Input.Should().Be(1000);
        entries[2].Output.Should().Be(300);
    }

    [Fact]
    public void Rate_limits_map_windows_by_length()
    {
        var (_, limits, _) = ParseFixture();

        limits.Should().HaveCount(2);
        var first = limits[0];
        first.Agent.Should().Be(AgentIds.Codex);
        first.FiveHour!.UsedPercent.Should().Be(12.0);
        first.FiveHour.ResetsAt.Should().Be(DateTimeOffset.FromUnixTimeSeconds(1791140000));
        first.SevenDay!.UsedPercent.Should().Be(3.5);
        limits[1].SevenDay.Should().BeNull("secondary was null in that line");
    }

    [Fact]
    public void Legacy_resets_in_seconds_is_relative_to_the_line()
    {
        var line = """
            {"timestamp":"2026-10-04T10:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":null,
             "rate_limits":{"primary":{"used_percent":50,"window_minutes":300,"resets_in_seconds":600}}}}
            """.ReplaceLineEndings(" ");

        var (entry, limits) = CodexRolloutParser.ParseLine(Encoding.UTF8.GetBytes(line), new CodexRolloutState { SessionId = "s" });

        entry.Should().BeNull("info is null");
        limits!.FiveHour!.ResetsAt.Should().Be(new DateTimeOffset(2026, 10, 4, 10, 10, 0, TimeSpan.Zero));
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("""{"type":"event_msg","payload":{"type":"token_count"}}""")]
    [InlineData("""{"timestamp":"2026-10-04T10:00:00Z","type":"response_item","payload":{"type":"message","content":"token_count"}}""")]
    public void Other_or_broken_lines_yield_nothing(string line)
    {
        CodexRolloutParser.ParseLine(Encoding.UTF8.GetBytes(line), new CodexRolloutState { SessionId = "s" })
            .Should().Be(((UsageEntry?)null, (PlanLimits?)null));
    }
}
