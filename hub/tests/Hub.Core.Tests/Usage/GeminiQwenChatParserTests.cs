using System.Text;
using Hub.Core.Usage;

namespace Hub.Core.Tests.Usage;

/// <summary>Gemini CLI and Qwen Code chat-recording usage on <c>adapters/{gemini,qwen}/fixtures/chat-*</c>.</summary>
public class GeminiQwenChatParserTests
{
    private static string FixturePath(string agent, string file)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "adapters")))
        {
            dir = dir.Parent;
        }

        return Path.Combine(dir!.FullName, "adapters", agent, "fixtures", file);
    }

    private static List<UsageEntry> GeminiEntries(GeminiChatState state) =>
        File.ReadAllLines(FixturePath("gemini", "chat-session.jsonl"))
            .Select(l => GeminiChatParser.ParseLine(Encoding.UTF8.GetBytes(l), state))
            .OfType<UsageEntry>()
            .ToList();

    [Fact]
    public void Gemini_reads_tokens_per_message_id_with_the_header_session()
    {
        var state = new GeminiChatState { ProjectRoot = @"C:\work\shop-api" };

        var entries = GeminiEntries(state);

        state.SessionId.Should().Be("7b0c2f9e-3d4a-4c1e-9a55-2f1d8e6b4c10");
        entries.Select(e => e.DedupKey).Should().Equal(
            "gemini:7b0c2f9e-3d4a-4c1e-9a55-2f1d8e6b4c10:m-g1",
            "gemini:7b0c2f9e-3d4a-4c1e-9a55-2f1d8e6b4c10:m-g2",
            "gemini:7b0c2f9e-3d4a-4c1e-9a55-2f1d8e6b4c10:m-g2");
        entries.DistinctBy(e => e.DedupKey).Should().HaveCount(2, "a re-appended message keeps its id, so the usage table stores it once");

        var first = entries[0];
        first.Input.Should().Be(18234 - 12000, "input includes the cached part");
        first.CacheRead.Should().Be(12000);
        first.Output.Should().Be(120 + 310, "thoughts are billed as output");
        first.Model.Should().Be("gemini-2.5-pro");
        first.Agent.Should().Be("gemini");
        first.ProjectRoot.Should().Be(@"C:\work\shop-api");
        first.SessionId.Should().Be("7b0c2f9e-3d4a-4c1e-9a55-2f1d8e6b4c10");
        first.Timestamp.Should().Be(DateTimeOffset.Parse("2026-10-06T09:15:23.900Z", System.Globalization.CultureInfo.InvariantCulture));
        first.IsSidechain.Should().BeFalse();
        entries[1].Input.Should().Be(19102 - 18000 + 12, "tool-use prompt tokens are extra input");
        entries[1].Output.Should().Be(450 + 95);
    }

    [Fact]
    public void Gemini_lines_without_a_header_have_no_session_and_give_nothing()
    {
        var state = new GeminiChatState();
        var line = File.ReadAllLines(FixturePath("gemini", "chat-session.jsonl"))[4];

        GeminiChatParser.ParseLine(Encoding.UTF8.GetBytes(line), state).Should().BeNull();
    }

    [Fact]
    public void Gemini_subagent_header_marks_entries_as_sidechain()
    {
        var state = new GeminiChatState();
        GeminiChatParser.ParseLine("""{"sessionId":"sub-1","projectHash":"x","startTime":"2026-10-06T09:00:00Z","kind":"subagent"}"""u8, state);

        var entry = GeminiChatParser.ParseLine(
            """{"id":"a","timestamp":"2026-10-06T09:00:01Z","type":"gemini","model":"gemini-2.5-flash","tokens":{"input":10,"output":2}}"""u8, state);

        entry!.IsSidechain.Should().BeTrue();
        entry.SessionId.Should().Be("sub-1");
    }

    [Fact]
    public void Gemini_legacy_document_is_read_whole()
    {
        var state = new GeminiChatState();

        var entries = GeminiChatParser.ParseDocument(File.ReadAllBytes(FixturePath("gemini", "chat-legacy.json")), state);

        entries.Should().ContainSingle();
        entries[0].DedupKey.Should().Be("gemini:5d1e7a20-0000-4000-8000-00000000aa01:g1");
        entries[0].Input.Should().Be(5000);
        entries[0].Output.Should().Be(250);
        entries[0].Model.Should().Be("gemini-2.5-flash");
    }

    [Theory]
    [InlineData("""{"id":"x","timestamp":"2026-10-06T09:00:01Z","type":"user","tokens":{"input":10}}""")]
    [InlineData("""{"id":"x","timestamp":"2026-10-06T09:00:01Z","type":"gemini","tokens":{"input":0,"output":0}}""")]
    [InlineData("""{"id":"x","type":"gemini","tokens":{"input":10}}""")]
    [InlineData("""{"id":"x","timestamp":"2026-10-06T09:00:01Z","type":"gemini","tokens":""")]
    public void Gemini_ignores_lines_without_usable_tokens(string line)
    {
        GeminiChatParser.ParseLine(Encoding.UTF8.GetBytes(line), new GeminiChatState { SessionId = "s" }).Should().BeNull();
    }

    [Fact]
    public void Qwen_reads_only_assistant_usage_metadata()
    {
        var entries = File.ReadAllLines(FixturePath("qwen", "chat-session.jsonl"))
            .Select(l => QwenChatParser.ParseLine(Encoding.UTF8.GetBytes(l), "fallback"))
            .OfType<UsageEntry>()
            .ToList();

        entries.Select(e => e.DedupKey).Should().Equal(
            "qwen:1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11:r2", "qwen:1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11:r4");
        entries[0].Input.Should().Be(17020 - 15000, "promptTokenCount includes the cached part");
        entries[0].CacheRead.Should().Be(15000);
        entries[0].Output.Should().Be(64);
        entries[1].Output.Should().Be(72 + 20, "thoughts are billed as output");
        entries.Should().OnlyContain(e => e.Agent == "qwen" && e.Model == "qwen3-coder-plus" && e.ProjectRoot == @"C:\work\shop-api"
            && e.SessionId == "1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11");
    }

    [Fact]
    public void Qwen_falls_back_to_the_file_session_id()
    {
        var entry = QwenChatParser.ParseLine(
            """{"uuid":"u","timestamp":"2026-10-06T10:00:00Z","type":"assistant","usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1}}"""u8,
            "from-file");

        entry!.SessionId.Should().Be("from-file");
        entry.Input.Should().Be(10);
    }
}
