using System.Text;
using Hub.Core.Adapters;
using Hub.Core.Hooks;
using Hub.Core.Sessions;

namespace Hub.Core.Tests;

public class CodexAdapterTests
{
    private static HookEvent Parse(string json)
    {
        var e = HookEventParser.Parse(Encoding.UTF8.GetBytes(json), TestAdapters.BuiltIn, out var error);
        error.Should().Be(HookParseError.None);
        return e!;
    }

    [Fact]
    public void Permission_request_maps_to_the_normalized_event_with_envelope_metadata()
    {
        var e = Parse(Fixtures.Read("codex/permission_request.json"));

        e.Agent.Should().Be(AgentIds.Codex);
        e.Kind.Should().Be(HookEventKind.PermissionRequest);
        e.SessionId.Should().Be("0199a1b2-0000-7000-8000-000000000001");
        e.ToolName.Should().Be("Bash");
        e.Cwd.Should().Be(@"C:\src\beta");
        e.Model.Should().Be("gpt-test-codex");
        e.PaneId.Should().Be("pane-1");
        e.WorkspaceId.Should().Be("ws-1");
        e.TranscriptPath.Should().EndWith("0199a1b2-0000-7000-8000-000000000001.jsonl");
        AgentProcessResolver.Resolve(e).Should().Be(4200, "cmd.exe is the hook's shell; codex.exe is the agent");
    }

    [Fact]
    public void Stop_never_carries_the_assistant_message()
    {
        var e = Parse(Fixtures.Read("codex/stop.json"));

        e.Kind.Should().Be(HookEventKind.Stop);
        e.TranscriptPath.Should().BeNull();
        e.Message.Should().BeNull();
        typeof(HookEvent).GetProperties().Select(p => p.Name).Should().NotContain(n => n.Contains("Assistant", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("SessionStart", HookEventKind.SessionStart)]
    [InlineData("SessionEnd", HookEventKind.SessionEnd)]
    [InlineData("UserPromptSubmit", HookEventKind.UserPromptSubmit)]
    [InlineData("PreToolUse", HookEventKind.PreToolUse)]
    [InlineData("PostToolUse", HookEventKind.PostToolUse)]
    [InlineData("Interrupt", HookEventKind.Interrupt)]
    [InlineData("PostCompact", HookEventKind.PostCompact)]
    [InlineData("PreCompact", HookEventKind.Other)]
    [InlineData("SubagentStart", HookEventKind.SubagentStart)]
    [InlineData("Notification", HookEventKind.Other)]
    public void Event_names_map_to_normalized_kinds(string name, HookEventKind expected)
    {
        var e = Parse($$$"""{"agent":"codex","event":"{{{name}}}","payload":{"session_id":"s"}}""");

        e.Kind.Should().Be(expected);
        e.HookEventName.Should().Be(name);
    }

    [Fact]
    public void Envelope_event_falls_back_to_the_payload_name_and_agent_to_claude_code()
    {
        var e = Parse("""{"payload":{"session_id":"s","hook_event_name":"Stop"}}""");

        e.Agent.Should().Be(AgentIds.ClaudeCode);
        e.Kind.Should().Be(HookEventKind.Stop);
    }

    [Fact]
    public void Unknown_agent_is_rejected()
    {
        HookEventParser.Parse("""{"agent":"mystery","event":"Stop","payload":{"session_id":"s"}}"""u8, TestAdapters.BuiltIn, out var error).Should().BeNull();
        error.Should().Be(HookParseError.UnknownAgent);
    }

    [Fact]
    public void Claude_does_not_accept_codex_only_kinds()
    {
        Parse("""{"agent":"claude-code","event":"Interrupt","payload":{"session_id":"s"}}""").Kind.Should().Be(HookEventKind.Other);
    }

    [Fact]
    public void Interrupt_returns_a_working_session_to_idle()
    {
        var t0 = TestData.T0;
        var working = SessionStateMachine.Apply(null, TestData.Hook(HookEventKind.UserPromptSubmit, t0) with { Agent = AgentIds.Codex }).Session;

        var (s, change) = SessionStateMachine.Apply(working, TestData.Hook(HookEventKind.Interrupt, t0.AddSeconds(5)) with { Agent = AgentIds.Codex });

        s.State.Should().Be(SessionState.Idle);
        s.Agent.Should().Be(AgentIds.Codex);
        s.TurnStartedAt.Should().BeNull();
        change!.Detail.Should().Be("interrupt");
    }

    [Fact]
    public void Post_compact_resets_context_without_changing_state()
    {
        var t0 = TestData.T0;
        var working = SessionStateMachine.Apply(null, TestData.Hook(HookEventKind.UserPromptSubmit, t0)).Session;

        var (s, change) = SessionStateMachine.Apply(working, TestData.Hook(HookEventKind.PostCompact, t0.AddSeconds(5)));

        change.Should().BeNull();
        s.State.Should().Be(SessionState.Working);
        s.ContextResetAt.Should().Be(t0.AddSeconds(5));
    }

    [Fact]
    public void Tracker_keeps_same_session_id_from_two_agents_apart()
    {
        var tracker = new SessionTracker(new FakeEnvironment(), new SessionOptions());
        tracker.Apply(TestData.Hook(HookEventKind.UserPromptSubmit, TestData.T0, sessionId: "same"));
        tracker.Apply(TestData.Hook(HookEventKind.Stop, TestData.T0.AddSeconds(1), sessionId: "same") with { Agent = AgentIds.Codex });

        tracker.Snapshot.Should().HaveCount(2);
        tracker.Get(AgentIds.ClaudeCode, "same")!.State.Should().Be(SessionState.Working);
        tracker.Get(AgentIds.Codex, "same")!.State.Should().Be(SessionState.Idle);
    }

    [Fact]
    public void Pane_id_is_kept_once_known()
    {
        var first = SessionStateMachine.Apply(null, TestData.Hook(HookEventKind.SessionStart, TestData.T0) with { PaneId = "p1" }).Session;
        var next = SessionStateMachine.Apply(first, TestData.Hook(HookEventKind.UserPromptSubmit, TestData.T0.AddSeconds(1))).Session;

        next.PaneId.Should().Be("p1");
    }
}
