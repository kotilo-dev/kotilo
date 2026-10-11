using System.Text;
using Hub.Core.Adapters;
using Hub.Core.Hooks;
using Hub.Core.Sessions;

namespace Hub.Core.Tests;

public class CopilotAdapterTests
{
    private const string SessionId = "6f1c2d3e-0000-4000-8000-00000000c001";

    private static readonly AdapterRegistry Registry = new([new ClaudeCodeAdapter(), new CopilotAdapter()]);

    private static HookEvent Parse(string json)
    {
        var e = HookEventParser.Parse(Encoding.UTF8.GetBytes(json), Registry, out var error);
        error.Should().Be(HookParseError.None);
        return e!;
    }

    private static HookEvent Event(string name, string payload) =>
        Parse($$"""{"v":1,"agent":"copilot","event":"{{name}}","receivedAt":"2026-10-06T09:00:00.000Z","payload":{{payload}}}""");

    [Fact]
    public void Permission_request_reads_camel_case_fields_and_the_tool_input()
    {
        var e = Parse(Fixtures.Read("copilot/permission_request.json"));

        e.Agent.Should().Be(AgentIds.Copilot);
        e.Kind.Should().Be(HookEventKind.PermissionRequest);
        e.SessionId.Should().Be(SessionId);
        e.Cwd.Should().Be(@"C:\src\gamma");
        e.ToolName.Should().Be("powershell");
        e.ToolCommand.Should().Be(@"Remove-Item -Recurse .\dist");
        e.PaneId.Should().Be("pane-3");
        AgentProcessResolver.Resolve(e).Should().Be(5200, "pwsh.exe runs the hook; copilot.exe is the agent");
    }

    [Fact]
    public void Tool_args_json_string_gives_the_path()
    {
        var e = Parse(Fixtures.Read("copilot/post_tool_use.json"));

        e.Kind.Should().Be(HookEventKind.PostToolUse);
        e.ToolName.Should().Be("edit");
        e.ToolPath.Should().Be(@"C:\src\gamma\app.ts");
        e.ToolCommand.Should().BeNull();
    }

    [Theory]
    [InlineData("""{"sessionId":"s","toolArgs":"not json"}""")]
    [InlineData("""{"sessionId":"s","toolArgs":"{\"command\":"}""")]
    [InlineData("""{"sessionId":"s","toolArgs":42}""")]
    public void Broken_tool_args_are_ignored(string payload)
    {
        var e = Event("postToolUse", payload);

        e.ToolCommand.Should().BeNull();
        e.ToolPath.Should().BeNull();
    }

    [Theory]
    [InlineData("sessionStart", HookEventKind.SessionStart)]
    [InlineData("sessionEnd", HookEventKind.SessionEnd)]
    [InlineData("userPromptSubmitted", HookEventKind.UserPromptSubmit)]
    [InlineData("postToolUse", HookEventKind.PostToolUse)]
    [InlineData("permissionRequest", HookEventKind.PermissionRequest)]
    [InlineData("agentStop", HookEventKind.Stop)]
    [InlineData("errorOccurred", HookEventKind.Error)]
    [InlineData("preToolUse", HookEventKind.Other)]
    [InlineData("subagentStart", HookEventKind.Other)]
    [InlineData("SessionStart", HookEventKind.Other)]
    public void Event_names_map_to_normalized_kinds(string name, HookEventKind expected)
    {
        var e = Event(name, """{"sessionId":"s"}""");

        e.Kind.Should().Be(expected);
        e.HookEventName.Should().Be(name);
    }

    [Theory]
    [InlineData("permission_prompt", HookEventKind.Notification, SessionState.WaitingPermission)]
    [InlineData("elicitation_dialog", HookEventKind.Notification, SessionState.WaitingInput)]
    [InlineData("agent_idle", HookEventKind.Done, SessionState.Idle)]
    [InlineData("agent_completed", HookEventKind.Notification, SessionState.Working)]
    [InlineData("shell_completed", HookEventKind.Notification, SessionState.Working)]
    public void Notification_types_drive_the_session_state(string type, HookEventKind kind, SessionState expected)
    {
        var e = Event("notification", $$"""{"sessionId":"s","hook_event_name":"Notification","message":"Copilot needs your permission","notification_type":"{{type}}"}""");
        var working = SessionStateMachine.Apply(null, Event("userPromptSubmitted", """{"sessionId":"s","prompt_length":12}""")).Session;

        e.Kind.Should().Be(kind);
        e.NotificationType.Should().Be(type);
        SessionStateMachine.Apply(working, e with { ReceivedAt = e.ReceivedAt.AddSeconds(1) }).Session.State.Should().Be(expected);
    }

    [Fact]
    public void Permission_notification_keeps_the_tool_from_the_permission_request()
    {
        var request = Parse(Fixtures.Read("copilot/permission_request.json"));
        var s = SessionStateMachine.Apply(null, request).Session;

        var after = SessionStateMachine.Apply(
            s, Event("notification", $$"""{"sessionId":"{{SessionId}}","notification_type":"permission_prompt","message":"Copilot needs permission"}""") with
            {
                ReceivedAt = request.ReceivedAt.AddSeconds(1),
            }).Session;

        after.State.Should().Be(SessionState.WaitingPermission);
        after.PendingPermission!.Command.Should().Be(@"Remove-Item -Recurse .\dist");
        after.PendingPermission.Risk.Should().Be(PermissionRisk.DeletesFiles);
    }

    [Fact]
    public void Prompt_text_never_arrives_only_its_length()
    {
        var e = Event("userPromptSubmitted", """{"sessionId":"s","prompt_length":42}""");

        e.PromptLength.Should().Be(42);
        e.Message.Should().BeNull();
    }

    [Theory]
    [InlineData("RateLimitError", "Rate limit exceeded", "rateLimit")]
    [InlineData("CAPIError", "You have exceeded your premium request quota", "usageLimit")]
    [InlineData("AuthError", "401 Unauthorized", "auth")]
    [InlineData("Error", "socket hang up", "api")]
    public void Unrecoverable_errors_end_the_turn_with_a_kind(string name, string message, string kind)
    {
        var e = Event("errorOccurred", $$"""{"sessionId":"s","error":{"name":"{{name}}","message":"{{message}}"},"errorContext":"model_call","recoverable":false}""");

        e.Kind.Should().Be(HookEventKind.Error);
        e.ErrorType.Should().Be(kind);
        e.ErrorDetails.Should().Be(message);
    }

    [Fact]
    public void Recoverable_errors_change_nothing()
    {
        Event("errorOccurred", """{"sessionId":"s","error":{"message":"retrying"},"recoverable":true}""").Kind.Should().Be(HookEventKind.Other);
    }

    [Fact]
    public void Missing_session_id_is_rejected()
    {
        HookEventParser.Parse("""{"v":1,"agent":"copilot","event":"agentStop","payload":{"cwd":"C:\\x"}}"""u8, Registry, out var error).Should().BeNull();
        error.Should().Be(HookParseError.MissingSessionId);
    }
}
