using Hub.Core.Usage;
using static Hub.Core.Tests.Usage.UsageTestData;

namespace Hub.Core.Tests.Usage;

public class TranscriptUsageParserTests
{
    [Fact]
    public void Extracts_usage_fields()
    {
        var e = Parse(AssistantLine(), out var kind);

        kind.Should().Be(TranscriptLineKind.Usage);
        e!.Input.Should().Be(10);
        e.Output.Should().Be(20);
        e.CacheCreate5m.Should().Be(300);
        e.CacheRead.Should().Be(4000);
        e.TotalTokens.Should().Be(4330);
        e.Model.Should().Be("claude-opus-5-5");
        e.SessionId.Should().Be("s1");
        e.ProjectRoot.Should().Be(@"C:\src\alpha");
        e.Timestamp.Should().Be(T0);
        e.DedupKey.Should().Be("msg:msg_1|req:req_1");
    }

    [Fact]
    public void Cache_creation_breakdown_replaces_the_flat_field()
    {
        var e = Parse(AssistantLine(cacheCreate: 999, cache5m: 100, cache1h: 200), out _);

        e!.CacheCreate5m.Should().Be(100);
        e.CacheCreate1h.Should().Be(200);
        e.CacheCreate.Should().Be(300, "the breakdown is not added to cache_creation_input_tokens");
    }

    [Fact]
    public void Missing_request_id_keys_by_message_session_and_time()
    {
        var e = Parse(AssistantLine(requestId: null), out _);
        e!.DedupKey.Should().Be($"msg:msg_1|sid:s1|ts:{T0.ToUnixTimeMilliseconds()}");
    }

    [Fact]
    public void Missing_message_id_falls_back_to_line_hash()
    {
        var line = AssistantLine().Replace("\"id\":\"msg_1\",", "", StringComparison.Ordinal);
        var a = Parse(line, out _);
        var b = Parse(line, out _);

        a!.DedupKey.Should().StartWith("line:").And.Be(b!.DedupKey);
        Parse(line.Replace("\"output_tokens\":20", "\"output_tokens\":21", StringComparison.Ordinal), out _)!
            .DedupKey.Should().NotBe(a.DedupKey);
    }

    [Fact]
    public void Same_response_on_several_lines_shares_the_key()
    {
        Parse(AssistantLine(), out _)!.DedupKey.Should().Be(Parse(AssistantLine(output: 25), out _)!.DedupKey);
    }

    [Fact]
    public void Sidechain_and_fast_flags_are_read()
    {
        var e = Parse(AssistantLine(sidechain: true, speed: "fast"), out _);
        e!.IsSidechain.Should().BeTrue();
        e.IsFast.Should().BeTrue();
    }

    [Theory]
    [InlineData("""{"type":"user","message":{"role":"user","content":"x"},"usage":"mention"}""")]
    [InlineData("""{"type":"system","subtype":"x"}""")]
    [InlineData("""{"type":"assistant","message":{"id":"m","content":[]}}""")]
    [InlineData("")]
    public void Lines_without_assistant_usage_are_skipped(string line)
    {
        Parse(line, out var kind).Should().BeNull();
        kind.Should().Be(TranscriptLineKind.NoUsage);
    }

    [Theory]
    [InlineData("""{"type":"user","message":{"content":"hi"}}""", TranscriptLineKind.NoUsage)]
    [InlineData("""{"type":"user","message":{"content":"hi"}""", TranscriptLineKind.Invalid)]
    [InlineData("""{"type":"user"} trailing""", TranscriptLineKind.Invalid)]
    [InlineData("""[1,2]""", TranscriptLineKind.Invalid)]
    [InlineData("""{"type":"assistant","message":{"usage":{"input_tokens":1}""", TranscriptLineKind.Invalid)]
    public void Lines_without_the_usage_marker_are_only_checked_for_well_formedness(string line, TranscriptLineKind expected)
    {
        Parse(line, out var kind).Should().BeNull();
        kind.Should().Be(expected);
    }

    [Fact]
    public void Half_written_line_is_invalid()
    {
        var line = AssistantLine();
        Parse(line[..(line.Length / 2)], out var kind).Should().BeNull();
        kind.Should().Be(TranscriptLineKind.Invalid);
    }

    [Fact]
    public void Usage_without_required_fields_is_malformed()
    {
        Parse("""{"type":"assistant","timestamp":"2026-09-30T18:00:00Z","message":{"id":"m","usage":{"output_tokens":5}}}""", out var kind)
            .Should().BeNull();
        kind.Should().Be(TranscriptLineKind.MalformedUsage);
    }

    [Fact]
    public void Session_id_falls_back_to_file_name()
    {
        var line = AssistantLine().Replace("\"sessionId\":\"s1\",", "", StringComparison.Ordinal);
        Parse(line, out _)!.SessionId.Should().Be("fallback");
    }

    [Fact]
    public void Larger_or_main_chain_duplicate_replaces_existing()
    {
        var small = Parse(AssistantLine(output: 5), out _)!;
        var large = Parse(AssistantLine(output: 50), out _)!;
        var sidechainLarge = Parse(AssistantLine(output: 500, sidechain: true), out _)!;

        TranscriptUsageParser.ShouldReplace(small, large).Should().BeTrue();
        TranscriptUsageParser.ShouldReplace(large, small).Should().BeFalse();
        TranscriptUsageParser.ShouldReplace(large, large with { }).Should().BeFalse("equal totals keep the first");
        TranscriptUsageParser.ShouldReplace(sidechainLarge, small).Should().BeTrue("main chain beats sidechain");
        TranscriptUsageParser.ShouldReplace(small, sidechainLarge).Should().BeFalse();
    }
}
