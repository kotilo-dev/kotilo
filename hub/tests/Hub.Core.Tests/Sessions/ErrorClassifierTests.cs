using System.Text;
using Hub.Core.Hooks;
using Hub.Core.Notifications;
using Hub.Core.Sessions;
using static Hub.Core.Tests.TestData;

namespace Hub.Core.Tests.Sessions;

public sealed class ErrorClassifierTests
{
    private static readonly TimeZoneInfo Istanbul = TimeZoneInfo.FindSystemTimeZoneById("Europe/Istanbul");

    /// <summary>12:00 UTC = 15:00 in Istanbul.</summary>
    private static readonly DateTimeOffset At = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);

    private static readonly string[] Lines = Fixtures.Read("errors/api-errors.jsonl").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private static TranscriptError? Classify(int index) =>
        ErrorClassifier.FromTranscriptLine(Encoding.UTF8.GetBytes(Lines[index]), "fallback", Istanbul);

    [Fact]
    public void Old_usage_limit_form_carries_an_epoch_reset()
    {
        var e = Classify(0)!;
        e.SessionId.Should().Be("s1");
        e.At.Should().Be(At);
        e.Error.Should().Be(new SessionError(SessionErrorKind.UsageLimit, DateTimeOffset.FromUnixTimeSeconds(1759352400)));
    }

    [Fact]
    public void Hit_your_limit_with_zone_resets_at_the_next_7pm_there()
    {
        var e = Classify(1)!.Error;
        e.Kind.Should().Be(SessionErrorKind.UsageLimit);
        e.ResetsAt.Should().Be(new DateTimeOffset(2026, 10, 1, 19, 0, 0, TimeSpan.FromHours(3)));
    }

    [Fact]
    public void Error_field_wins_and_clock_without_zone_uses_local_zone()
    {
        var e = Classify(2)!.Error;
        e.Kind.Should().Be(SessionErrorKind.UsageLimit);
        e.ResetsAt.Should().Be(new DateTimeOffset(2026, 10, 1, 15, 30, 0, TimeSpan.FromHours(3)));
    }

    [Theory]
    [InlineData(3, SessionErrorKind.RateLimited)]
    [InlineData(4, SessionErrorKind.Overloaded)]
    [InlineData(5, SessionErrorKind.AuthError)]
    [InlineData(6, SessionErrorKind.ApiError)]
    public void Api_error_lines_are_classified(int index, SessionErrorKind kind)
    {
        var e = Classify(index)!.Error;
        e.Kind.Should().Be(kind);
        e.ResetsAt.Should().BeNull();
    }

    [Theory]
    [InlineData(7)]
    [InlineData(8)]
    public void Lines_not_flagged_as_api_errors_never_match(int index) => Classify(index).Should().BeNull();

    [Fact]
    public void A_reset_time_already_past_today_means_tomorrow()
    {
        // 15:00 local now; "resets 9am" is tomorrow morning.
        ErrorClassifier.ParseResetsAt("Usage limit reached · resets 9am", At, Istanbul)
            .Should().Be(new DateTimeOffset(2026, 10, 2, 9, 0, 0, TimeSpan.FromHours(3)));
    }

    [Fact]
    public void Dated_reset_is_parsed()
    {
        ErrorClassifier.ParseResetsAt("Weekly limit reached · resets Oct 3, 2pm (Europe/Istanbul)", At, Istanbul)
            .Should().Be(new DateTimeOffset(2026, 10, 3, 14, 0, 0, TimeSpan.FromHours(3)));
    }

    [Theory]
    [InlineData("rate_limit", "Rate limit exceeded. Please retry after 60 seconds.", SessionErrorKind.RateLimited)]
    [InlineData("rate_limit", "You've hit your session limit · resets 7pm", SessionErrorKind.UsageLimit)]
    [InlineData("overloaded", null, SessionErrorKind.Overloaded)]
    [InlineData("authentication_failed", null, SessionErrorKind.AuthError)]
    [InlineData("oauth_org_not_allowed", null, SessionErrorKind.AuthError)]
    [InlineData("billing_error", null, SessionErrorKind.UsageLimit)]
    [InlineData("server_error", null, SessionErrorKind.ApiError)]
    [InlineData("unknown", null, SessionErrorKind.ApiError)]
    public void Stop_failure_error_types_map_to_sub_types(string error, string? details, SessionErrorKind kind) =>
        ErrorClassifier.FromStopFailure(error, details, At, Istanbul)!.Kind.Should().Be(kind);

    [Fact]
    public void Max_output_tokens_is_not_an_attention_state() =>
        ErrorClassifier.FromStopFailure("max_output_tokens", null, At, Istanbul).Should().BeNull();

    [Fact]
    public void Stop_failure_moves_to_error_and_a_new_prompt_back_to_working()
    {
        var (s, _) = SessionStateMachine.Apply(null, Hook(HookEventKind.UserPromptSubmit, T0));
        var failure = Hook(HookEventKind.StopFailure, T0.AddSeconds(5)) with
        {
            ErrorType = "rate_limit",
            ErrorDetails = "You've hit your limit · resets 7pm (Europe/Istanbul)",
        };
        var (failed, change) = SessionStateMachine.Apply(s, failure, Istanbul);

        failed.State.Should().Be(SessionState.Error);
        failed.Error!.Kind.Should().Be(SessionErrorKind.UsageLimit);
        failed.Error.ResetsAt.Should().NotBeNull();
        change!.Detail.Should().Be("UsageLimit");
        failed.State.NeedsAttention().Should().BeTrue();

        var (resumed, _) = SessionStateMachine.Apply(failed, Hook(HookEventKind.UserPromptSubmit, T0.AddMinutes(1)));
        resumed.State.Should().Be(SessionState.Working);
        resumed.Error.Should().BeNull();

        var (tool, _) = SessionStateMachine.Apply(failed, Hook(HookEventKind.PreToolUse, T0.AddMinutes(1), tool: "Bash"));
        tool.State.Should().Be(SessionState.Working);
    }

    [Fact]
    public void Transcript_error_applies_only_when_newer_than_hooks()
    {
        var tracker = new SessionTracker(new FakeEnvironment(), new SessionOptions());
        tracker.Apply(Hook(HookEventKind.UserPromptSubmit, T0));
        var error = new SessionError(SessionErrorKind.Overloaded, null);

        tracker.ApplyTranscriptError(new TranscriptError("s1", T0.AddSeconds(-1), error)).Should().BeNull();
        var change = tracker.ApplyTranscriptError(new TranscriptError("s1", T0.AddSeconds(10), error));

        change!.To.Should().Be(SessionState.Error);
        change.Trigger.Should().Be(TransitionTrigger.Transcript);
        tracker.Get("s1")!.Error.Should().Be(error);
    }

    [Fact]
    public void Error_rule_fires_once_per_sub_type_within_ten_minutes()
    {
        var engine = new RuleEngine(new RuleOptions());
        var tracker = new SessionTracker(new FakeEnvironment(), new SessionOptions());
        tracker.Apply(Hook(HookEventKind.UserPromptSubmit, T0));

        SessionStateChanged Fail(DateTimeOffset at, string type)
        {
            var (_, c) = tracker.Apply(Hook(HookEventKind.StopFailure, at) with { ErrorType = type });
            engine.OnStateChanged(c!);
            return c!;
        }

        Fail(T0.AddSeconds(5), "overloaded");
        engine.Poll(T0.AddSeconds(7), tracker.Snapshot).Should().ContainSingle(r => r.RuleId == RuleIds.Error && r.Error!.Kind == SessionErrorKind.Overloaded);

        tracker.Apply(Hook(HookEventKind.UserPromptSubmit, T0.AddMinutes(1)));
        Fail(T0.AddMinutes(2), "overloaded");
        engine.Poll(T0.AddMinutes(2).AddSeconds(2), tracker.Snapshot).Should().BeEmpty("same sub-type within 10 min");

        tracker.Apply(Hook(HookEventKind.UserPromptSubmit, T0.AddMinutes(3)));
        Fail(T0.AddMinutes(4), "rate_limit");
        engine.Poll(T0.AddMinutes(4).AddSeconds(2), tracker.Snapshot).Should().ContainSingle(r => r.Error!.Kind == SessionErrorKind.RateLimited);
    }
}
