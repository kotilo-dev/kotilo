using System.Text;
using Hub.Core.Adapters;
using Hub.Core.Usage;

namespace Hub.Core.Tests.Usage;

public class CopilotSessionUsageTests
{
    private static List<UsageEntry> ParseAll(IEnumerable<string> lines, CopilotSessionUsage.State? state = null)
    {
        state ??= new CopilotSessionUsage.State();
        return lines.SelectMany(l => CopilotSessionUsage.ParseLine(Encoding.UTF8.GetBytes(l), state)).ToList();
    }

    private static string[] Lines() => Fixtures.Read("copilot/events.jsonl").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    [Fact]
    public void Shutdown_totals_become_one_entry_per_model_without_a_price()
    {
        var entries = ParseAll(Lines().Take(4));

        entries.Should().HaveCount(2);
        var sonnet = entries.Single(e => e.Model == "claude-sonnet-4.5");
        sonnet.SessionId.Should().Be("6f1c2d3e-0000-4000-8000-00000000c001");
        sonnet.ProjectRoot.Should().Be(@"C:\src\gamma");
        sonnet.Input.Should().Be(3000, "input tokens include the 9000 cache reads");
        sonnet.CacheRead.Should().Be(9000);
        sonnet.CacheCreate5m.Should().Be(500);
        sonnet.Output.Should().Be(800);
        sonnet.Timestamp.Should().Be(new DateTimeOffset(2026, 10, 6, 9, 10, 0, TimeSpan.Zero));
        sonnet.Agent.Should().Be(AgentIds.Copilot);
        entries.Should().OnlyContain(e => e.CostUsd == null && e.CostReported, "Copilot bills premium requests, not API token prices");
    }

    [Fact]
    public void A_shutdown_after_resume_counts_only_what_grew()
    {
        var entries = ParseAll(Lines());

        var second = entries.Where(e => e.Timestamp.Hour == 11).ToList();
        second.Should().ContainSingle("gpt-5-mini did not change after the resume");
        second[0].Model.Should().Be("claude-sonnet-4.5");
        second[0].Input.Should().Be(1000);
        second[0].CacheRead.Should().Be(2000);
        second[0].Output.Should().Be(200);
        entries.Sum(e => e.Output).Should().Be(1200, "the totals of the last shutdown, counted once");
        entries.Select(e => e.DedupKey).Should().OnlyHaveUniqueItems();
    }

    [Fact]
    public void Message_lines_are_never_parsed_and_need_a_session_id()
    {
        ParseAll(Lines().Skip(1).Take(3)).Should().BeEmpty("without session.start (or a folder name) there is no session id");

        var state = new CopilotSessionUsage.State { SessionId = "from-folder" };
        ParseAll(Lines().Skip(3).Take(1), state).Should().OnlyContain(e => e.SessionId == "from-folder" && e.ProjectRoot == null);
    }

    [Fact]
    public void Smaller_totals_are_a_fresh_count()
    {
        var state = new CopilotSessionUsage.State { SessionId = "s" };
        static string Shutdown(string id, int input) =>
            """{"type":"session.shutdown","data":{"modelMetrics":{"m":{"requests":{"count":1},"usage":{"inputTokens":"""
            + input.ToString(System.Globalization.CultureInfo.InvariantCulture)
            + ""","outputTokens":10,"cacheReadTokens":0,"cacheWriteTokens":0}}}},"id":""" + "\"" + id + "\""
            + ""","timestamp":"2026-10-06T09:00:00.000Z"}""";

        ParseAll([Shutdown("a", 500), Shutdown("b", 200)], state).Select(e => e.Input).Should().Equal(500, 200);
    }

    [Theory]
    [InlineData("not json \"session.shutdown\"")]
    [InlineData("""{"type":"session.shutdown","data":{"modelMetrics":"x"},"id":"a","timestamp":"2026-10-06T09:00:00Z"}""")]
    [InlineData("""{"type":"session.shutdown","data":{"modelMetrics":{"m":{"usage":null}}},"id":"a","timestamp":"2026-10-06T09:00:00Z"}""")]
    public void Malformed_lines_are_skipped(string line) =>
        ParseAll([line], new CopilotSessionUsage.State { SessionId = "s" }).Should().BeEmpty();
}
