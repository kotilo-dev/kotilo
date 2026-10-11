using System.Text;
using Hub.Core.Adapters;
using Hub.Core.Hooks;
using Hub.Core.Sessions;

namespace Hub.Core.Tests;

public class OpenCodeAdapterTests
{
    private static readonly AdapterRegistry Registry = new([new OpenCodeAdapter()]);

    private static HookEvent Parse(string json)
    {
        var e = HookEventParser.Parse(Encoding.UTF8.GetBytes(json), Registry, out var error);
        error.Should().Be(HookParseError.None);
        return e!;
    }

    private static HookEvent Event(string name, string payload, int second = 0) =>
        Parse($$"""{"v":1,"agent":"opencode","event":"{{name}}","receivedAt":"2026-10-06T09:00:{{second:00}}.000Z","payload":{{payload}}}""");

    [Fact]
    public void Permission_asked_carries_tool_command_and_a_windows_cwd()
    {
        var e = Parse(Fixtures.Read("opencode/permission_asked.json"));

        e.Agent.Should().Be(AgentIds.OpenCode);
        e.Kind.Should().Be(HookEventKind.PermissionRequest);
        e.SessionId.Should().Be("ses_0a1b2c3d4e5fOpenCodeTest");
        e.ToolName.Should().Be("shell");
        e.ToolCommand.Should().Be("git push --force");
        e.Cwd.Should().Be(@"C:\src\delta");
    }

    [Fact]
    public void The_service_process_chain_is_not_the_agent_process()
    {
        var e = Parse(Fixtures.Read("opencode/permission_asked.json"));

        e.ProcessChain.Should().BeEmpty();
        e.ParentPid.Should().BeNull();
        AgentProcessResolver.Resolve(e).Should().BeNull("the plugin runs in OpenCode's shared service, which outlives every pane");
    }

    [Theory]
    [InlineData("session.created", HookEventKind.SessionStart)]
    [InlineData("session.deleted", HookEventKind.SessionEnd)]
    [InlineData("session.status", HookEventKind.Working)]
    [InlineData("session.execution.started", HookEventKind.Working)]
    [InlineData("session.execution.succeeded", HookEventKind.Done)]
    [InlineData("session.execution.interrupted", HookEventKind.Interrupt)]
    [InlineData("session.execution.failed", HookEventKind.Error)]
    [InlineData("session.idle", HookEventKind.Done)]
    [InlineData("permission.asked", HookEventKind.PermissionRequest)]
    [InlineData("permission.replied", HookEventKind.Working)]
    [InlineData("form.created", HookEventKind.WaitingInput)]
    [InlineData("form.replied", HookEventKind.Working)]
    [InlineData("form.cancelled", HookEventKind.Working)]
    [InlineData("session.usage.updated", HookEventKind.Other)]
    public void Event_names_map_to_normalized_kinds(string name, HookEventKind expected)
    {
        Event(name, """{"sessionId":"ses_1"}""").Kind.Should().Be(expected);
        OpenCodeAdapter.Events.Contains(name).Should().Be(expected != HookEventKind.Other, "the plugin forwards exactly the mapped events");
    }

    [Fact]
    public void A_turn_runs_through_permission_and_question_to_done()
    {
        var s = SessionStateMachine.Apply(null, Event("session.created", """{"sessionId":"ses_1","cwd":"C:/src/delta"}""")).Session;
        s.ProjectRoot.Should().Be(@"C:\src\delta");
        s.State.Should().Be(SessionState.Idle);

        s = SessionStateMachine.Apply(s, Event("session.execution.started", """{"sessionId":"ses_1"}""", 1)).Session;
        s.State.Should().Be(SessionState.Working);
        s = SessionStateMachine.Apply(s, Event("permission.asked", """{"sessionId":"ses_1","tool":"edit","path":"C:/src/delta/app.ts"}""", 2)).Session;
        s.State.Should().Be(SessionState.WaitingPermission);
        s.PendingPermission!.Path.Should().Be(@"C:\src\delta\app.ts");
        s = SessionStateMachine.Apply(s, Event("permission.replied", """{"sessionId":"ses_1","reply":"once"}""", 3)).Session;
        s.State.Should().Be(SessionState.Working);
        s = SessionStateMachine.Apply(s, Event("form.created", """{"sessionId":"ses_1"}""", 4)).Session;
        s.State.Should().Be(SessionState.WaitingInput);
        s = SessionStateMachine.Apply(s, Event("form.replied", """{"sessionId":"ses_1"}""", 5)).Session;
        s.State.Should().Be(SessionState.Working);
        s = SessionStateMachine.Apply(s, Event("session.execution.succeeded", """{"sessionId":"ses_1"}""", 6)).Session;
        s.State.Should().Be(SessionState.Idle);
        s.LastCompletedAt.Should().NotBeNull();
    }

    [Theory]
    [InlineData("""{"sessionId":"s","errorType":"api","status":429,"message":"Too many requests"}""", "rateLimit")]
    [InlineData("""{"sessionId":"s","errorType":"ProviderAuthError","message":"bad key"}""", "auth")]
    [InlineData("""{"sessionId":"s","errorType":"api","status":529}""", "overloaded")]
    [InlineData("""{"sessionId":"s","errorType":"unknown"}""", "api")]
    public void Failed_executions_carry_an_error_kind(string payload, string kind)
    {
        var e = Event("session.execution.failed", payload);

        e.Kind.Should().Be(HookEventKind.Error);
        e.ErrorType.Should().Be(kind);
    }

    [Theory]
    [InlineData("C:/src/delta", @"C:\src\delta")]
    [InlineData(@"C:\src\delta", @"C:\src\delta")]
    [InlineData("/home/dev/delta", "/home/dev/delta")]
    [InlineData("/", "/")]
    [InlineData(null, null)]
    public void Windows_paths_get_backslashes(string? input, string? expected) =>
        OpenCodeAdapter.WindowsPath(input).Should().Be(expected);
}
