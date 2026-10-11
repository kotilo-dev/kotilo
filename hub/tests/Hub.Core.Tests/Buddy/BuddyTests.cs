using Hub.Core.Buddy;

namespace Hub.Core.Tests.Buddy;

public class ClaudeCliStreamParserTests
{
    private static IEnumerable<string> Fixture(string name) =>
        File.ReadLines(Path.Combine(AppContext.BaseDirectory, "Fixtures", "buddy", name));

    [Fact]
    public void Partial_stream_fixture_assembles_text_once_with_session_and_usage()
    {
        var assembler = new BuddyResponseAssembler();
        var changes = 0;
        foreach (var line in Fixture("stream-partial.jsonl"))
        {
            if (ClaudeCliStreamParser.ParseLine(line) is { } e && assembler.Apply(e))
            {
                changes++;
            }
        }

        assembler.Text.Should().Be("İki artı iki **dört**.", "the full assistant message must not repeat streamed deltas");
        changes.Should().Be(2);
        assembler.SessionId.Should().Be("00000000-0000-4000-8000-00000000b0d1");
        assembler.Model.Should().Be("claude-haiku-4-5-20251001");
        var result = assembler.Result!;
        result.IsError.Should().BeFalse();
        result.InputTokens.Should().Be(6675);
        result.OutputTokens.Should().Be(270);
        result.CostUsd.Should().Be(0.01469m);
    }

    [Fact]
    public void Init_reports_tool_count_so_the_app_can_verify_tools_are_off()
    {
        var init = ClaudeCliStreamParser.ParseLine(Fixture("stream-partial.jsonl").ElementAt(1)).Should().BeOfType<BuddyStreamEvent.Init>().Subject;
        init.ToolCount.Should().Be(0);
    }

    [Fact]
    public void Without_deltas_the_full_assistant_message_is_used()
    {
        var a = new BuddyResponseAssembler();
        a.Apply(new BuddyStreamEvent.AssistantText("Merhaba")).Should().BeTrue();
        a.Apply(new BuddyStreamEvent.AssistantText("ikinci")).Should().BeTrue();
        a.Text.Should().Be("Merhaba\n\nikinci");
    }

    [Fact]
    public void Result_text_fills_an_empty_answer_but_errors_do_not()
    {
        var ok = new BuddyResponseAssembler();
        ok.Apply(new BuddyStreamEvent.Result("s", false, "sadece sonuç", 1, 1, null));
        ok.Text.Should().Be("sadece sonuç");

        var failed = new BuddyResponseAssembler();
        failed.Apply(new BuddyStreamEvent.Result("s", true, "Not logged in", 0, 0, null));
        failed.Text.Should().BeEmpty();
        failed.Result!.IsError.Should().BeTrue();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("{broken")]
    [InlineData("[1,2]")]
    [InlineData("""{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}}""")]
    [InlineData("""{"type":"system","subtype":"init"}""")]
    [InlineData("""{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}""")]
    public void Ignored_lines(string line) => ClaudeCliStreamParser.ParseLine(line).Should().BeNull();
}

public class BuddySessionFilterTests
{
    private readonly BuddySessionFilter _filter = new(@"C:\Users\u\AppData\Local\agent-hub\buddy");

    [Theory]
    [InlineData(@"C:\Users\u\AppData\Local\agent-hub\buddy", true)]
    [InlineData(@"c:\users\U\appdata\local\agent-hub\BUDDY\", true)]
    [InlineData(@"C:\Users\u\AppData\Local\agent-hub\buddy\sub", true)]
    [InlineData("C:/Users/u/AppData/Local/agent-hub/buddy", true)]
    [InlineData(@"C:\Users\u\AppData\Local\agent-hub\buddy2", false)]
    [InlineData(@"C:\Users\u\AppData\Local\agent-hub", false)]
    [InlineData(@"C:\dev\project", false)]
    [InlineData(null, false)]
    [InlineData("", false)]
    public void Matches_buddy_folder_and_below(string? cwd, bool expected) => _filter.IsBuddy(cwd).Should().Be(expected);
}

public class HotkeyGestureTests
{
    [Theory]
    [InlineData("Ctrl+Alt+Space", HotkeyModifiers.Control | HotkeyModifiers.Alt, 0x20u, "Ctrl+Alt+Space")]
    [InlineData(" alt + shift + b ", HotkeyModifiers.Alt | HotkeyModifiers.Shift, (uint)'B', "Alt+Shift+B")]
    [InlineData("Win+F12", HotkeyModifiers.Windows, 0x7Bu, "Win+F12")]
    [InlineData("Control+1", HotkeyModifiers.Control, (uint)'1', "Ctrl+1")]
    [InlineData("Ctrl+`", HotkeyModifiers.Control, 0xC0u, "Ctrl+`")]
    public void Parses(string text, HotkeyModifiers modifiers, uint vk, string normalized)
    {
        var g = HotkeyGesture.Parse(text)!;
        g.Modifiers.Should().Be(modifiers);
        g.VirtualKey.Should().Be(vk);
        g.Text.Should().Be(normalized);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("Space")]
    [InlineData("Shift+A")]
    [InlineData("Ctrl+Hyper+A")]
    [InlineData("Ctrl+Alt+")]
    [InlineData("Ctrl+F25")]
    [InlineData("Ctrl+Alt+Banana")]
    public void Rejects(string? text) => HotkeyGesture.Parse(text).Should().BeNull();
}
