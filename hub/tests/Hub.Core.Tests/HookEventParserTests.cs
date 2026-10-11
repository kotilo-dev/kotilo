using System.Text;
using Hub.Core.Hooks;

namespace Hub.Core.Tests;

public class HookEventParserTests
{
    private static HookEvent? Parse(string json, out HookParseError error) =>
        HookEventParser.Parse(Encoding.UTF8.GetBytes(json), TestAdapters.BuiltIn, out error);

    [Fact]
    public void Parses_envelope_and_common_fields()
    {
        var e = Parse(Fixtures.Read("hooks/pre_tool_use.json"), out var error);

        error.Should().Be(HookParseError.None);
        e.Should().NotBeNull();
        e!.SessionId.Should().Be("abc123");
        e.Kind.Should().Be(HookEventKind.PreToolUse);
        e.ToolName.Should().Be("Bash");
        e.Cwd.Should().Be(@"C:\src\alpha");
        e.HookPid.Should().Be(1234);
        e.ParentPid.Should().Be(1200);
        e.ReceivedAt.Should().Be(new DateTimeOffset(2026, 9, 30, 18, 12, 0, 123, TimeSpan.Zero));
        e.ProcessChain.Should().Equal(new ProcessRef(1200, "bash.exe"), new ProcessRef(900, "claude.exe"));
    }

    [Fact]
    public void Notification_fields_are_read()
    {
        var e = Parse(Fixtures.Read("hooks/notification_permission.json"), out _);

        e!.Kind.Should().Be(HookEventKind.Notification);
        e.NotificationType.Should().Be("permission_prompt");
        e.Message.Should().Be("Claude needs your permission to use Bash");
    }

    [Fact]
    public void Prompt_text_is_not_kept_only_its_length()
    {
        var e = Parse(Fixtures.Read("hooks/user_prompt_submit.json"), out _);

        e!.Kind.Should().Be(HookEventKind.UserPromptSubmit);
        e.PromptLength.Should().Be("secret prompt text".Length);
        typeof(HookEvent).GetProperties().Select(p => p.Name).Should().NotContain("Prompt");
    }

    [Fact]
    public void Missing_session_id_is_rejected()
    {
        Parse("""{"payload":{"hook_event_name":"Stop"}}""", out var error).Should().BeNull();
        error.Should().Be(HookParseError.MissingSessionId);
    }

    [Theory]
    [InlineData("not json", HookParseError.InvalidJson)]
    [InlineData("""{"payload":"x"}""", HookParseError.MissingPayload)]
    [InlineData("[]", HookParseError.MissingPayload)]
    public void Invalid_input_is_rejected(string json, HookParseError expected)
    {
        Parse(json, out var error).Should().BeNull();
        error.Should().Be(expected);
    }

    [Fact]
    public void Unknown_fields_and_events_are_tolerated()
    {
        var e = Parse("""
            {"receivedAt":12,"hookPid":"x","processChain":[1,{"pid":"y"}],"future":true,
             "payload":{"session_id":"s","hook_event_name":"SomethingNew","cwd":5,"extra":{"a":1}}}
            """, out var error);

        error.Should().Be(HookParseError.None);
        e!.Kind.Should().Be(HookEventKind.Other);
        e.HookEventName.Should().Be("SomethingNew");
        e.Cwd.Should().BeNull();
        e.HookPid.Should().BeNull();
        e.ProcessChain.Should().BeEmpty();
    }

    [Fact]
    public void Long_notification_message_is_truncated()
    {
        var msg = new string('a', 2000);
        var e = Parse($$$"""{"payload":{"session_id":"s","hook_event_name":"Notification","message":"{{{msg}}}"}}""", out _);
        e!.Message.Should().HaveLength(500);
    }
}
