using System.Text;
using Hub.Core.Adapters;
using Hub.Core.Hooks;
using Hub.Core.Sessions;

namespace Hub.Core.Tests;

public class CursorAdapterTests
{
    private const string Conversation = "c0ffee00-1111-4222-8333-444455556666";

    private static HookEvent Parse(AdapterRegistry registry, string json)
    {
        var e = HookEventParser.Parse(Encoding.UTF8.GetBytes(json), registry, out var error);
        error.Should().Be(HookParseError.None);
        return e!;
    }

    private static AdapterRegistry Registry() => new([new CursorAdapter()]);

    private static string[] SessionLines() => Fixtures.Read("cursor/session.jsonl").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    [Fact]
    public void Fixture_session_walks_through_the_expected_states()
    {
        var registry = Registry();
        SessionInfo? session = null;
        var states = new List<SessionState>();
        var events = new List<HookEvent>();
        foreach (var line in SessionLines())
        {
            var e = Parse(registry, line);
            events.Add(e);
            (session, _) = SessionStateMachine.Apply(session, e, TimeZoneInfo.Utc);
            states.Add(session.State);
        }

        states.Should().Equal(
            SessionState.Idle,     // sessionStart
            SessionState.Working,  // afterShellExecution
            SessionState.Working,  // postToolUse
            SessionState.Working,  // afterFileEdit
            SessionState.Idle,     // stop completed
            SessionState.Ended);   // sessionEnd
        events.Should().OnlyContain(e => e.Agent == AgentIds.Cursor && e.SessionId == Conversation);
        events[1].ToolName.Should().Be("Shell");
        events[1].ToolCommand.Should().Be("npm test");
        events[2].ToolCommand.Should().Be("npm test");
        events[3].ToolName.Should().Be("Edit");
        events[3].ToolPath.Should().Be("C:/Users/dev/src/demo/src/app.ts");
        session!.ProjectRoot.Should().Be(@"C:\Users\dev\src\demo", "a forward-slash workspace root is normalized");
        session.Model.Should().Be("gpt-5");
        session.EndReason.Should().Be("user_close");
        session.PaneId.Should().Be("pane-9");
    }

    [Theory]
    [InlineData("completed", HookEventKind.Stop, SessionState.Idle)]
    [InlineData("aborted", HookEventKind.Interrupt, SessionState.Idle)]
    [InlineData("error", HookEventKind.Error, SessionState.Error)]
    [InlineData(null, HookEventKind.Stop, SessionState.Idle)]
    public void Stop_status_decides_how_the_turn_ended(string? status, HookEventKind kind, SessionState state)
    {
        var registry = Registry();
        var (s, _) = SessionStateMachine.Apply(null, Parse(registry, Envelope("postToolUse", "\"tool_name\":\"Shell\"", 0)));
        var statusField = status is null ? string.Empty : $"\"status\":\"{status}\"";
        var stop = Parse(registry, Envelope("stop", statusField, 1));
        (s, _) = SessionStateMachine.Apply(s, stop);

        stop.Kind.Should().Be(kind);
        s.State.Should().Be(state);
        if (state == SessionState.Error)
        {
            s.Error!.Kind.Should().Be(SessionErrorKind.ApiError);
        }
    }

    [Theory]
    [InlineData("sessionStart", HookEventKind.SessionStart)]
    [InlineData("sessionEnd", HookEventKind.SessionEnd)]
    [InlineData("postToolUse", HookEventKind.PostToolUse)]
    [InlineData("postToolUseFailure", HookEventKind.PostToolUseFailure)]
    [InlineData("afterShellExecution", HookEventKind.PostToolUse)]
    [InlineData("afterFileEdit", HookEventKind.PostToolUse)]
    [InlineData("afterMCPExecution", HookEventKind.PostToolUse)]
    [InlineData("beforeSubmitPrompt", HookEventKind.UserPromptSubmit)]
    [InlineData("preCompact", HookEventKind.PostCompact)]
    [InlineData("preToolUse", HookEventKind.Other)]
    [InlineData("beforeShellExecution", HookEventKind.Other)]
    [InlineData("afterAgentThought", HookEventKind.Other)]
    public void Event_names_map_to_normalized_kinds(string name, HookEventKind expected)
    {
        Parse(Registry(), Envelope(name, string.Empty, 0)).Kind.Should().Be(expected);
    }

    [Fact]
    public void Conversation_id_is_the_session_key_and_a_payload_without_one_is_rejected()
    {
        var e = Parse(Registry(), """{"agent":"cursor","event":"stop","payload":{"conversation_id":"c1","generation_id":"g9","session_id":"x"}}""");
        e.SessionId.Should().Be("c1");

        HookEventParser.Parse("""{"agent":"cursor","event":"stop","payload":{"generation_id":"g9"}}"""u8, Registry(), out var error)
            .Should().BeNull();
        error.Should().Be(HookParseError.MissingSessionId);
    }

    [Theory]
    [InlineData(@"C:\Users\dev\src\demo", @"C:\Users\dev\src\demo")]
    [InlineData("C:/Users/dev/src/demo", @"C:\Users\dev\src\demo")]
    [InlineData("/home/dev/src/demo", "/home/dev/src/demo")]
    public void Workspace_root_is_the_cwd_in_either_path_style(string root, string expected)
    {
        var json = $$$"""{"agent":"cursor","event":"sessionStart","payload":{"conversation_id":"c1","workspace_roots":["{{{root.Replace(@"\", @"\\", StringComparison.Ordinal)}}}","D:/other"]}}""";
        Parse(Registry(), json).Cwd.Should().Be(expected);
    }

    [Fact]
    public void A_double_fired_event_maps_once_and_a_later_repeat_maps_again()
    {
        var registry = Registry();
        var line = SessionLines()[4]; // stop
        var first = Parse(registry, line);
        var twin = Parse(registry, line.Replace("10:00:31.000Z", "10:00:31.400Z", StringComparison.Ordinal));
        var later = Parse(registry, line.Replace("10:00:31.000Z", "10:00:40.000Z", StringComparison.Ordinal));

        first.Kind.Should().Be(HookEventKind.Stop);
        twin.Kind.Should().Be(HookEventKind.Other, "the same payload within the window is a double fire");
        twin.HookEventName.Should().Be("stop");
        later.Kind.Should().Be(HookEventKind.Stop);

        // A different payload in the window is a new event.
        Parse(registry, Envelope("postToolUse", "\"tool_use_id\":\"t1\"", 0)).Kind.Should().Be(HookEventKind.PostToolUse);
        Parse(registry, Envelope("postToolUse", "\"tool_use_id\":\"t2\"", 0)).Kind.Should().Be(HookEventKind.PostToolUse);
    }

    [Fact]
    public void Without_the_dedupe_the_state_machine_still_absorbs_a_double_fire()
    {
        SessionInfo? s = null;
        var changes = new List<SessionStateChanged>();
        foreach (var line in SessionLines())
        {
            // A fresh adapter per event: no dedupe memory, every repeat is mapped in full.
            for (var i = 0; i < 2; i++)
            {
                (s, var change) = SessionStateMachine.Apply(s, Parse(Registry(), line));
                if (change is not null)
                {
                    changes.Add(change);
                }
            }
        }

        changes.Select(c => c.To).Should().Equal(SessionState.Idle, SessionState.Working, SessionState.Idle, SessionState.Ended);
    }

    private static string Envelope(string name, string fields, int second)
    {
        var extra = fields.Length == 0 ? string.Empty : "," + fields;
        return $$$"""{"v":1,"agent":"cursor","event":"{{{name}}}","receivedAt":"2026-10-05T09:00:{{{second:00}}}.000Z","payload":{"conversation_id":"{{{Conversation}}}","hook_event_name":"{{{name}}}","workspace_roots":["C:/src/demo"]{{{extra}}}}}""";
    }
}
