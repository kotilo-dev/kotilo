using Hub.Core.Buddy;
using Hub.Core.Sessions;
using static Hub.Core.Tests.TestData;

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

public class MascotStateResolverTests
{
    private static readonly DateTimeOffset Now = T0.AddHours(1);

    private static SessionInfo S(string id, SessionState state, int minutesAgo = 1) => Session(state, Now.AddMinutes(-minutesAgo)) with { SessionId = id };

    private static MascotState Resolve(IReadOnlyList<SessionInfo> sessions, bool sweat = false, DateTimeOffset? done = null, bool dnd = false) =>
        MascotStateResolver.Resolve(new MascotInputs(sessions, sweat, done, dnd), Now);

    [Fact]
    public void Priority_order_is_perm_input_sweat_work_done_sleep()
    {
        var all = new[] { S("w", SessionState.Working), S("i", SessionState.WaitingInput), S("p", SessionState.WaitingPermission) };
        Resolve(all, sweat: true, done: Now).Should().Be(MascotState.Perm);
        Resolve(all[..2], sweat: true, done: Now).Should().Be(MascotState.Input);
        Resolve(all[..1], sweat: true, done: Now).Should().Be(MascotState.Sweat);
        Resolve(all[..1], done: Now).Should().Be(MascotState.Work);
        Resolve([S("idle", SessionState.Idle)], done: Now).Should().Be(MascotState.Done);
        Resolve([S("idle", SessionState.Idle)]).Should().Be(MascotState.Sleep);
        Resolve([]).Should().Be(MascotState.Sleep);
    }

    [Fact]
    public void Sweat_needs_a_working_session()
    {
        Resolve([S("idle", SessionState.Idle)], sweat: true).Should().Be(MascotState.Sleep);
    }

    [Fact]
    public void Done_lasts_three_seconds()
    {
        Resolve([], done: Now.AddSeconds(-2.9)).Should().Be(MascotState.Done);
        Resolve([], done: Now.AddSeconds(-3)).Should().Be(MascotState.Sleep);
        Resolve([], done: Now.AddSeconds(1)).Should().Be(MascotState.Sleep, "a future timestamp is clock skew, not a celebration");
    }

    [Fact]
    public void Do_not_disturb_always_sleeps()
    {
        Resolve([S("p", SessionState.WaitingPermission)], dnd: true).Should().Be(MascotState.Sleep);
    }

    [Fact]
    public void Ended_and_unknown_sessions_are_ignored()
    {
        Resolve([S("e", SessionState.Ended), S("u", SessionState.Unknown)]).Should().Be(MascotState.Sleep);
    }

    [Fact]
    public void Oldest_permission_wait_is_the_click_target_and_speed_grows_with_work()
    {
        var sessions = new[] { S("new", SessionState.WaitingPermission, 1), S("old", SessionState.WaitingPermission, 9), S("w", SessionState.Working) };
        MascotStateResolver.OldestWaitingForPermission(sessions)!.SessionId.Should().Be("old");

        var inputs = new MascotInputs([S("a", SessionState.Working), S("b", SessionState.Working), S("c", SessionState.Working)], false, null, false);
        MascotStateResolver.SpeedFactor(inputs).Should().BeApproximately(1.3, 1e-9);
        MascotStateResolver.SpeedFactor(inputs with { Sessions = Enumerable.Range(0, 20).Select(i => S($"s{i}", SessionState.Working)).ToList() })
            .Should().Be(1.6);
    }
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

public class SpriteSheetTests
{
    private static SpriteSheet Load() =>
        SpriteSheet.Parse(Fixtures.Read(Path.Combine("buddy", "sprites.json")));

    [Fact]
    public void Every_mascot_state_has_a_16x16_sprite_with_its_antenna_color()
    {
        var sheet = Load();
        foreach (var state in Enum.GetValues<MascotState>())
        {
            var sprite = sheet.For(state);
            sprite.Size.Should().Be(16);
            sprite.Pixels.Should().HaveCount(256);
        }

        // Row 1, column 7 is the antenna light ('L').
        sheet.For(MascotState.Perm)[7, 1].Should().Be(0xFFFF9F43);
        sheet.For(MascotState.Input)[7, 1].Should().Be(0xFFFCE100);
        sheet.For(MascotState.Sleep)[7, 1].Should().Be(0xFF6E7880);
        sheet["base"][7, 1].Should().Be(0xFF60CDFF);
        sheet["base"][0, 0].Should().Be(0u);
        sheet["base"].IsOpaque(0, 0).Should().BeFalse();
        sheet["base"].IsOpaque(7, 1).Should().BeTrue();

        // Error (spec §18.5): the input look with a red "!" instead of the yellow "?" and a red antenna light.
        var error = sheet.For(MascotState.Error);
        error[7, 1].Should().Be(SpriteSheet.ErrorColor);
        error[2, 0].Should().Be(SpriteSheet.ErrorColor);
        error[2, 4].Should().Be(SpriteSheet.ErrorColor);
        error.Pixels.Should().NotContain(0xFFFCE100u);
    }

    [Fact]
    public void Mirror_flips_columns()
    {
        var sprite = Load()["perm"];
        var mirrored = sprite.Mirrored();
        mirrored[15 - 1, 0].Should().Be(sprite[1, 0]);
        mirrored.Mirrored().Pixels.Should().Equal(sprite.Pixels);
    }

    [Fact]
    public void Malformed_sheets_are_rejected()
    {
        var act = () => SpriteSheet.Parse("""{"size":2,"palette":{"a":"#000000"},"states":{"x":{"antennaLight":"#FFFFFF","rows":["a.","?."]}}}""");
        act.Should().Throw<FormatException>().WithMessage("*unknown palette key*");

        var wrongSize = () => SpriteSheet.Parse("""{"size":2,"palette":{},"states":{"x":{"antennaLight":"#FFFFFF","rows":[".."]}}}""");
        wrongSize.Should().Throw<FormatException>();
    }
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

public class MarkdownLiteTests
{
    [Fact]
    public void Blocks_are_recognized()
    {
        const string md = """
            ## Başlık
            Bir paragraf
            devam ediyor.

            - madde **kalın**
              1. iç içe `kod`
            > alıntı

            ```rust
            let s = format!("{today:?}");
            ```
            """;

        var blocks = MarkdownLite.Parse(md);
        blocks.Should().HaveCount(6);
        blocks[0].Should().BeOfType<MdBlock.Heading>().Which.Level.Should().Be(2);
        MarkdownLite.ToPlainText(blocks[1].Should().BeOfType<MdBlock.Paragraph>().Subject.Inlines).Should().Be("Bir paragraf devam ediyor.");
        var item = blocks[2].Should().BeOfType<MdBlock.ListItem>().Subject;
        item.Marker.Should().Be("•");
        item.Inlines.Should().Equal(new MdInline("madde ", InlineStyle.Plain), new MdInline("kalın", InlineStyle.Bold));
        var nested = blocks[3].Should().BeOfType<MdBlock.ListItem>().Subject;
        nested.Indent.Should().Be(2);
        nested.Marker.Should().Be("1.");
        blocks[4].Should().BeOfType<MdBlock.Quote>();
        var code = blocks[5].Should().BeOfType<MdBlock.Code>().Subject;
        code.Language.Should().Be("rust");
        code.Text.Should().Be("let s = format!(\"{today:?}\");");
    }

    [Fact]
    public void Unclosed_fence_while_streaming_is_code_so_far()
    {
        var blocks = MarkdownLite.Parse("Örnek:\n```\nvar x = 1;\nvar y");
        blocks.Should().HaveCount(2);
        blocks[1].Should().Be(new MdBlock.Code(null, "var x = 1;\nvar y"));
    }

    [Theory]
    [InlineData("a *italik* b", InlineStyle.Italic, "italik")]
    [InlineData("a _italik_ b", InlineStyle.Italic, "italik")]
    [InlineData("**kalın**", InlineStyle.Bold, "kalın")]
    [InlineData("x `a*b*c` y", InlineStyle.Code, "a*b*c")]
    public void Inline_styles(string text, InlineStyle style, string content) =>
        MarkdownLite.Inlines(text).Should().ContainSingle(i => i.Style == style).Which.Text.Should().Be(content);

    [Theory]
    [InlineData("2 * 3 * 4")]
    [InlineData("snake_case_name")]
    [InlineData("tek * yıldız")]
    [InlineData("açık `kod")]
    public void Lone_markers_stay_plain(string text) =>
        MarkdownLite.Inlines(text).Should().Equal(new MdInline(text, InlineStyle.Plain));

    [Fact]
    public void Links_keep_their_label() =>
        MarkdownLite.ToPlainText(MarkdownLite.Inlines("bkz. [dokümantasyon](https://example.com) sonu")).Should().Be("bkz. dokümantasyon sonu");
}
