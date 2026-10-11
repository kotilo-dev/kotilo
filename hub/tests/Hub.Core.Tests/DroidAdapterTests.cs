using System.Text;
using Hub.Core.Adapters;
using Hub.Core.Hooks;
using Hub.Core.Sessions;

namespace Hub.Core.Tests;

public class DroidAdapterTests
{
    private const string SessionId = "7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6";

    private static HookEvent Parse(AdapterRegistry registry, string json)
    {
        var e = HookEventParser.Parse(Encoding.UTF8.GetBytes(json), registry, out var error);
        error.Should().Be(HookParseError.None);
        return e!;
    }

    private static AdapterRegistry Registry() => new([new DroidAdapter()]);

    [Fact]
    public void Fixture_session_walks_through_the_expected_states()
    {
        var registry = Registry();
        SessionInfo? session = null;
        var states = new List<SessionState>();
        PermissionPrompt? pending = null;
        foreach (var line in Fixtures.Read("droid/session.jsonl").Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var e = Parse(registry, line);
            e.Agent.Should().Be(AgentIds.Droid);
            e.SessionId.Should().Be(SessionId);
            (session, _) = SessionStateMachine.Apply(session, e, TimeZoneInfo.Utc);
            states.Add(session.State);
            pending ??= session.PendingPermission;
        }

        states.Should().Equal(
            SessionState.Idle,              // SessionStart
            SessionState.Working,           // UserPromptSubmit
            SessionState.Working,           // PreToolUse
            SessionState.WaitingPermission, // Notification permission_prompt
            SessionState.Working,           // PostToolUse
            SessionState.Working,           // SubagentStop: no change
            SessionState.Working,           // PreCompact: context reset only
            SessionState.Idle,              // Stop
            SessionState.Idle,              // Notification idle_prompt after a finished turn: a reminder (D-054)
            SessionState.Ended);            // SessionEnd
        pending.Should().NotBeNull();
        pending!.Tool.Should().Be("Execute");
        pending.Command.Should().Be("npm test", "the permission card shows the command of the PreToolUse before the prompt");
        session!.ProjectRoot.Should().Be(@"C:\Users\dev\src\demo");
        session.EndReason.Should().Be("prompt_input_exit");
        session.ContextResetAt.Should().NotBeNull("PreCompact resets the context reading");
        session.PaneId.Should().Be("pane-7");
    }

    [Fact]
    public void Prompt_text_never_reaches_the_event()
    {
        var e = Parse(Registry(), Fixtures.Read("droid/session.jsonl").Split('\n')[1]);

        e.Kind.Should().Be(HookEventKind.UserPromptSubmit);
        e.PromptLength.Should().Be(17);
        e.Model.Should().BeNull("Droid payloads carry no model");
    }

    [Fact]
    public void A_cancelled_turn_ends_on_idle_prompt_without_stop()
    {
        var registry = Registry();
        var (s, _) = SessionStateMachine.Apply(null, Parse(registry, Envelope("UserPromptSubmit", "\"prompt_length\":3", 0)));
        (s, var change) = SessionStateMachine.Apply(s, Parse(registry, Envelope("Notification", "\"notification_type\":\"idle_prompt\",\"message\":\"Droid is waiting for your input\"", 1)));

        s.State.Should().Be(SessionState.WaitingInput);
        change!.From.Should().Be(SessionState.Working);
    }

    [Fact]
    public void Permission_prompt_without_a_preceding_tool_still_waits_for_permission()
    {
        var e = Parse(Registry(), Envelope("Notification", "\"notification_type\":\"permission_prompt\"", 0));

        e.Kind.Should().Be(HookEventKind.PermissionRequest);
        e.ToolName.Should().BeNull();
        e.HookEventName.Should().Be("Notification");
    }

    [Fact]
    public void The_remembered_tool_is_per_session_and_cleared_after_the_tool_ran()
    {
        var registry = Registry();
        Parse(registry, Envelope("PreToolUse", "\"tool_name\":\"Execute\",\"tool_input\":{\"command\":\"rm -rf build\"}", 0));
        Parse(registry, Envelope("Notification", "\"notification_type\":\"permission_prompt\"", 1, session: "other")).ToolCommand.Should().BeNull();
        Parse(registry, Envelope("PostToolUse", "\"tool_name\":\"Execute\"", 2));
        Parse(registry, Envelope("Notification", "\"notification_type\":\"permission_prompt\"", 3)).ToolCommand.Should().BeNull();
    }

    [Theory]
    [InlineData("auth_success")]
    [InlineData("something_new")]
    public void Other_notifications_change_nothing(string type)
    {
        var registry = Registry();
        var (s, _) = SessionStateMachine.Apply(null, Parse(registry, Envelope("Stop", string.Empty, 0)));
        (s, var change) = SessionStateMachine.Apply(s, Parse(registry, Envelope("Notification", $"\"notification_type\":\"{type}\"", 1)));

        change.Should().BeNull();
        s.State.Should().Be(SessionState.Idle);
    }

    [Theory]
    [InlineData("SessionStart", HookEventKind.SessionStart)]
    [InlineData("SessionEnd", HookEventKind.SessionEnd)]
    [InlineData("UserPromptSubmit", HookEventKind.UserPromptSubmit)]
    [InlineData("PreToolUse", HookEventKind.PreToolUse)]
    [InlineData("PostToolUse", HookEventKind.PostToolUse)]
    [InlineData("Notification", HookEventKind.Notification)]
    [InlineData("Stop", HookEventKind.Stop)]
    [InlineData("SubagentStop", HookEventKind.SubagentStop)]
    [InlineData("PreCompact", HookEventKind.PostCompact)]
    [InlineData("SubagentStart", HookEventKind.Other)]
    [InlineData("PermissionRequest", HookEventKind.Other)]
    public void Event_names_map_to_normalized_kinds(string name, HookEventKind expected)
    {
        Parse(Registry(), Envelope(name, string.Empty, 0)).Kind.Should().Be(expected);
    }

    [Fact]
    public void An_event_without_a_session_id_is_rejected()
    {
        HookEventParser.Parse("""{"agent":"droid","event":"Stop","payload":{"cwd":"C:\\x"}}"""u8, Registry(), out var error)
            .Should().BeNull();
        error.Should().Be(HookParseError.MissingSessionId);
    }

    private static string Envelope(string name, string fields, int second, string session = SessionId)
    {
        var extra = fields.Length == 0 ? string.Empty : "," + fields;
        return $$$"""{"v":1,"agent":"droid","event":"{{{name}}}","receivedAt":"2026-10-05T09:00:{{{second:00}}}.000Z","payload":{"session_id":"{{{session}}}","cwd":"C:\\src\\demo","hook_event_name":"{{{name}}}"{{{extra}}}}}""";
    }
}
