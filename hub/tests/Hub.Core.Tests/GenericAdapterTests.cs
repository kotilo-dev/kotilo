using System.Globalization;
using System.Text;
using Hub.Core.Adapters;
using Hub.Core.Hooks;
using Hub.Core.Sessions;
using Hub.Core.Usage;

namespace Hub.Core.Tests;

/// <summary>Agent Integration Protocol v1 through <see cref="GenericAdapter"/>: event mapping and the resulting session states.</summary>
public class GenericAdapterTests
{
    private static readonly AdapterRegistry Registry = new([new ClaudeCodeAdapter(), new GenericAdapter("my-agent", "My Agent")]);

    private static readonly DateTimeOffset T0 = TestData.T0;

    private static HookEvent? Parse(string eventName, string payload, out HookParseError error, string? paneId = "pane-1", DateTimeOffset? at = null, int v = 1)
    {
        var pane = paneId is null ? string.Empty : $",\"paneId\":\"{paneId}\"";
        var json = string.Create(
            CultureInfo.InvariantCulture,
            $$"""{"v":{{v}},"agent":"my-agent","event":"{{eventName}}","receivedAt":"{{(at ?? T0).UtcDateTime:yyyy-MM-ddTHH:mm:ss.fffZ}}"{{pane}},"payload":{{payload}}}""");
        return HookEventParser.Parse(Encoding.UTF8.GetBytes(json), Registry, out error);
    }

    private static HookEvent Event(string eventName, string payload = "{}", DateTimeOffset? at = null)
    {
        var e = Parse(eventName, payload, out var error, at: at);
        error.Should().Be(HookParseError.None);
        return e!;
    }

    [Theory]
    [InlineData("session-start", HookEventKind.SessionStart)]
    [InlineData("working", HookEventKind.Working)]
    [InlineData("waiting-permission", HookEventKind.PermissionRequest)]
    [InlineData("waiting-input", HookEventKind.WaitingInput)]
    [InlineData("done", HookEventKind.Done)]
    [InlineData("error", HookEventKind.Error)]
    [InlineData("session-end", HookEventKind.SessionEnd)]
    [InlineData("usage", HookEventKind.Usage)]
    [InlineData("something-new", HookEventKind.Other)]
    public void Protocol_events_map_to_normalized_kinds(string name, HookEventKind kind)
    {
        var e = Event(name, """{"sessionId":"s-1","inputTokens":1,"outputTokens":2}""");

        e.Kind.Should().Be(kind);
        e.Agent.Should().Be("my-agent");
        e.SessionId.Should().Be("s-1");
        e.HookEventName.Should().Be(name);
        e.PaneId.Should().Be("pane-1");
    }

    [Fact]
    public void Session_start_carries_cwd_and_model()
    {
        var e = Event("session-start", """{"sessionId":"s-1","cwd":"C:\\src\\demo","model":"local-7b","unknownField":[1,2]}""");

        e.Cwd.Should().Be(@"C:\src\demo");
        e.Model.Should().Be("local-7b");
    }

    [Fact]
    public void Missing_session_id_falls_back_to_the_pane()
    {
        Event("done").SessionId.Should().Be("pane:pane-1");
    }

    [Fact]
    public void Missing_session_id_outside_a_pane_is_rejected()
    {
        Parse("done", "{}", out var error, paneId: null).Should().BeNull();

        error.Should().Be(HookParseError.MissingSessionId);
    }

    [Theory]
    [InlineData("""{"v":1,"agent":"my-agent","event":"done","paneId":"p"}""")]
    [InlineData("""{"v":1,"agent":"my-agent","event":"done","paneId":"p","payload":null}""")]
    public void A_missing_or_null_payload_reads_as_empty(string json)
    {
        var e = HookEventParser.Parse(Encoding.UTF8.GetBytes(json), Registry, out var error);

        error.Should().Be(HookParseError.None);
        e!.Kind.Should().Be(HookEventKind.Done);
    }

    [Fact]
    public void Another_envelope_version_is_rejected()
    {
        Parse("done", """{"sessionId":"s"}""", out var error, v: 2).Should().BeNull();

        error.Should().Be(HookParseError.UnsupportedVersion);
    }

    [Fact]
    public void Unknown_agent_is_still_rejected()
    {
        HookEventParser.Parse("""{"agent":"nobody","event":"done","payload":{"sessionId":"s"}}"""u8, Registry, out var error).Should().BeNull();

        error.Should().Be(HookParseError.UnknownAgent);
    }

    [Fact]
    public void Waiting_permission_keeps_tool_command_path_and_a_known_risk()
    {
        var e = Event("waiting-permission", """{"sessionId":"s","tool":"shell","command":"npm install left-pad","path":"C:\\x","risk":"gitPush"}""");

        e.ToolName.Should().Be("shell");
        e.ToolCommand.Should().Be("npm install left-pad");
        e.ToolPath.Should().Be(@"C:\x");
        e.Risk.Should().Be(PermissionRisk.GitPush, "the agent's own risk wins over the classifier");
    }

    [Theory]
    [InlineData("deletesFiles", PermissionRisk.DeletesFiles)]
    [InlineData("other", PermissionRisk.Other)]
    [InlineData("DeletesFiles", null)]
    [InlineData("3", null)]
    [InlineData("scary", null)]
    public void Only_the_documented_risk_names_pass_through(string value, PermissionRisk? expected)
    {
        GenericAdapter.RiskOf(value).Should().Be(expected);
    }

    [Fact]
    public void Error_maps_kind_and_clips_the_message()
    {
        var e = Event("error", $$"""{"sessionId":"s","kind":"rateLimit","message":"{{new string('x', 900)}}"}""");

        e.ErrorType.Should().Be("rateLimit");
        e.ErrorDetails.Should().HaveLength(500);
    }

    [Fact]
    public void Usage_reads_camel_case_token_counts()
    {
        var e = Event("usage", """{"sessionId":"s","model":"m1","inputTokens":1200,"outputTokens":80,"cachedTokens":900,"costUsd":0.0125}""");

        e.Usage.Should().Be(new ReportedUsage("m1", 1200, 80, 900, 0.0125m));
    }

    [Theory]
    [InlineData("""{"sessionId":"s","outputTokens":5}""")]
    [InlineData("""{"sessionId":"s","inputTokens":-1,"outputTokens":5}""")]
    [InlineData("""{"sessionId":"s","inputTokens":"10","outputTokens":5}""")]
    public void Usage_without_valid_counts_is_an_activity_ping(string payload)
    {
        var e = Event("usage", payload);

        e.Kind.Should().Be(HookEventKind.Other);
        e.Usage.Should().BeNull();
    }

    [Fact]
    public void A_full_turn_walks_the_session_states()
    {
        var tracker = new SessionTracker(new FakeEnvironment(), new SessionOptions());
        var states = new List<SessionState>();
        void Apply(string name, string payload, int second)
        {
            var (session, _) = tracker.Apply(Event(name, payload, T0.AddSeconds(second)));
            states.Add(session.State);
        }

        Apply("session-start", """{"sessionId":"s","cwd":"C:\\src\\demo"}""", 0);
        Apply("working", """{"sessionId":"s","tool":"edit"}""", 1);
        Apply("waiting-permission", """{"sessionId":"s","tool":"shell","command":"rm -rf build"}""", 2);
        var pending = tracker.Get("my-agent", "s")!.PendingPermission;
        Apply("working", """{"sessionId":"s"}""", 3);
        Apply("waiting-input", """{"sessionId":"s","question_length":12}""", 4);
        Apply("working", """{"sessionId":"s"}""", 5);
        var (done, change) = tracker.Apply(Event("done", """{"sessionId":"s"}""", T0.AddSeconds(9)));
        Apply("error", """{"sessionId":"s","kind":"usageLimit","message":"limit reached"}""", 10);
        var error = tracker.Get("my-agent", "s")!.Error;
        Apply("session-end", """{"sessionId":"s","reason":"exit"}""", 11);

        states.Should().Equal(
            SessionState.Idle, SessionState.Working, SessionState.WaitingPermission, SessionState.Working, SessionState.WaitingInput,
            SessionState.Working, SessionState.Error, SessionState.Ended);
        pending.Should().NotBeNull();
        pending!.Tool.Should().Be("shell");
        pending.Risk.Should().Be(PermissionRisk.DeletesFiles, "no risk sent: the classifier decides");
        done.State.Should().Be(SessionState.Idle);
        done.LastCompletedAt.Should().Be(T0.AddSeconds(9));
        change!.TurnDuration.Should().Be(TimeSpan.FromSeconds(8));
        error!.Kind.Should().Be(SessionErrorKind.UsageLimit);
        tracker.Get("my-agent", "s")!.Agent.Should().Be("my-agent");
    }

    [Theory]
    [InlineData("usageLimit", SessionErrorKind.UsageLimit)]
    [InlineData("rateLimit", SessionErrorKind.RateLimited)]
    [InlineData("overloaded", SessionErrorKind.Overloaded)]
    [InlineData("auth", SessionErrorKind.AuthError)]
    [InlineData("api", SessionErrorKind.ApiError)]
    [InlineData("whatever", SessionErrorKind.ApiError)]
    public void Error_kinds_map_to_session_errors(string kind, SessionErrorKind expected)
    {
        var (s, _) = SessionStateMachine.Apply(null, Event("error", $$"""{"sessionId":"s","kind":"{{kind}}"}"""));

        s.State.Should().Be(SessionState.Error);
        s.Error!.Kind.Should().Be(expected);
    }

    [Fact]
    public void A_usage_event_does_not_change_the_state()
    {
        var (working, _) = SessionStateMachine.Apply(null, Event("working", """{"sessionId":"s"}"""));

        var (after, change) = SessionStateMachine.Apply(
            working, Event("usage", """{"sessionId":"s","model":"m2","inputTokens":1,"outputTokens":1}""", T0.AddSeconds(1)));

        change.Should().BeNull();
        after.State.Should().Be(SessionState.Working);
    }

    [Fact]
    public void Usage_events_become_usage_entries_keyed_by_session_and_time()
    {
        var e = Event("usage", """{"sessionId":"s","model":"m1","inputTokens":100,"outputTokens":20,"cachedTokens":50}""", T0.AddSeconds(3));

        var entry = ReportedUsageEntry.From(e, projectRoot: @"C:\src\demo")!;

        entry.DedupKey.Should().Be($"my-agent:s:{T0.AddSeconds(3).ToUnixTimeMilliseconds()}");
        entry.Agent.Should().Be("my-agent");
        entry.SessionId.Should().Be("s");
        entry.ProjectRoot.Should().Be(@"C:\src\demo");
        entry.Model.Should().Be("m1");
        (entry.Input, entry.Output, entry.CacheRead, entry.CacheCreate).Should().Be((100L, 20L, 50L, 0L));
        entry.CostUsd.Should().BeNull();
        entry.CostReported.Should().BeFalse();

        var priced = ReportedUsageEntry.From(Event("usage", """{"sessionId":"s","inputTokens":1,"outputTokens":1,"costUsd":0.5}"""), null)!;
        priced.CostUsd.Should().Be(0.5m);
        priced.CostReported.Should().BeTrue();
        ReportedUsageEntry.From(Event("done", """{"sessionId":"s"}"""), null).Should().BeNull();
    }
}
