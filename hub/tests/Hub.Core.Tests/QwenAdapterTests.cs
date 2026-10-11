using System.Text.Json.Nodes;
using Hub.Core.Adapters;
using Hub.Core.Hooks;
using Hub.Core.Sessions;

namespace Hub.Core.Tests;

/// <summary>Qwen Code hook mapping on the synthetic payloads in <c>adapters/qwen/fixtures/hooks.jsonl</c>.</summary>
public class QwenAdapterTests
{
    private static IReadOnlyList<HookEvent> Events => GeminiAdapterTests.FixtureEvents(AgentIds.Qwen);

    private static HookEvent Payload(string json) => GeminiAdapterTests.Parse(AgentIds.Qwen, JsonNode.Parse(json)!.AsObject());

    [Fact]
    public void Fixture_events_map_to_normalized_kinds()
    {
        Events.Select(e => (e.HookEventName, e.Kind)).Should().Equal(
            ("SessionStart", HookEventKind.SessionStart),
            ("Notification", HookEventKind.Notification),
            ("UserPromptSubmit", HookEventKind.UserPromptSubmit),
            ("Notification", HookEventKind.Notification),
            ("PreToolUse", HookEventKind.PreToolUse),
            ("PostToolUse", HookEventKind.PostToolUse),
            ("UserPromptSubmit", HookEventKind.Working),
            ("PreToolUse", HookEventKind.PreToolUse),
            ("PostToolUseFailure", HookEventKind.PostToolUseFailure),
            ("Stop", HookEventKind.Stop),
            ("Notification", HookEventKind.Notification),
            ("StopFailure", HookEventKind.StopFailure),
            ("SessionEnd", HookEventKind.SessionEnd));
        Events.Should().OnlyContain(e => e.Agent == AgentIds.Qwen && e.Cwd == @"C:\work\shop-api");
        Events[0].Model.Should().Be("qwen3-coder-plus");
    }

    [Fact]
    public void Stop_reports_the_context_fill_as_a_percentage()
    {
        Events.Single(e => e.Kind == HookEventKind.Stop).ContextPercent.Should().BeApproximately(14.2, 1e-9);
        Payload("""{"session_id":"s","hook_event_name":"Stop","timestamp":"2026-10-06T10:00:00Z","context_limit":100000,"input_tokens":25000}""")
            .ContextPercent.Should().BeApproximately(25, 1e-9, "without context_usage the ratio is input / limit");
        Payload("""{"session_id":"s","hook_event_name":"Stop","timestamp":"2026-10-06T10:00:00Z","context_usage":1.3}""")
            .ContextPercent.Should().Be(100, "an overfull window is clamped");
        Payload("""{"session_id":"s","hook_event_name":"Stop","timestamp":"2026-10-06T10:00:00Z"}""").ContextPercent.Should().BeNull();
        Payload("""{"session_id":"s","hook_event_name":"PostToolUse","timestamp":"2026-10-06T10:00:00Z","context_usage":0.5}""")
            .ContextPercent.Should().BeNull("only Stop carries a reading");
    }

    [Fact]
    public void Stop_failure_carries_the_error_kind()
    {
        var e = Events.Single(e => e.Kind == HookEventKind.StopFailure);

        e.ErrorType.Should().Be("rate_limit");
        e.ErrorDetails.Should().Be("429 Too Many Requests");
        Events.Single(e => e.Kind == HookEventKind.PostToolUseFailure).ErrorType.Should().BeNull();
    }

    [Fact]
    public void A_session_walks_through_permission_continuation_context_and_error()
    {
        var steps = new List<(string Event, SessionState State)>();
        SessionInfo? s = null;
        foreach (var e in Events)
        {
            (s, _) = SessionStateMachine.Apply(s, e);
            steps.Add((e.HookEventName, s.State));
            if (e.Kind == HookEventKind.Stop)
            {
                s.ContextUsedPercent.Should().BeApproximately(14.2, 1e-9);
            }
        }

        steps.Should().Equal(
            ("SessionStart", SessionState.Idle),
            ("Notification", SessionState.WaitingInput),
            ("UserPromptSubmit", SessionState.Working),
            ("Notification", SessionState.WaitingPermission),
            ("PreToolUse", SessionState.Working),
            ("PostToolUse", SessionState.Working),
            ("UserPromptSubmit", SessionState.Working),
            ("PreToolUse", SessionState.Working),
            ("PostToolUseFailure", SessionState.Working),
            ("Stop", SessionState.Idle),
            ("Notification", SessionState.Idle), // idle_prompt after a finished turn: a reminder (D-054)
            ("StopFailure", SessionState.Error),
            ("SessionEnd", SessionState.Ended));
        s!.Model.Should().Be("qwen3-coder-plus");
    }

    [Fact]
    public void A_continuation_keeps_the_turn_start()
    {
        SessionInfo? s = null;
        foreach (var e in Events.Take(7))
        {
            (s, _) = SessionStateMachine.Apply(s, e);
        }

        s!.TurnStartedAt.Should().Be(Events[2].ReceivedAt, "the tool-result UserPromptSubmit is not a new turn");
    }

    [Fact]
    public void Idle_prompt_after_a_denied_permission_ends_the_wait()
    {
        SessionInfo? s = null;
        foreach (var e in Events.Take(4))
        {
            (s, _) = SessionStateMachine.Apply(s, e);
        }

        s!.State.Should().Be(SessionState.WaitingPermission);
        (s, _) = SessionStateMachine.Apply(s, Events[10] with { ReceivedAt = Events[3].ReceivedAt.AddSeconds(5) });

        s.State.Should().Be(SessionState.WaitingInput);
        s.PendingPermission.Should().BeNull();
    }

    [Fact]
    public void No_mapped_field_holds_content_even_from_an_unscrubbed_payload()
    {
        Events.Select(e => e.ToString()).Should().NotContain(t => t.Contains("SECRET", StringComparison.Ordinal));
    }
}
