using Hub.Core.Hooks;
using Hub.Core.Notifications;
using Hub.Core.Sessions;
using static Hub.Core.Tests.TestData;

namespace Hub.Core.Tests;

public class RuleEngineTests
{
    private readonly RuleEngine _engine = new(new RuleOptions());
    private SessionInfo? _session;

    /// <summary>Applies the hook to the session and feeds any transition to the engine.</summary>
    private void Event(HookEventKind kind, DateTimeOffset at, string? tool = null, string? type = null, string? message = null)
    {
        var (s, change) = SessionStateMachine.Apply(_session, Hook(kind, at, tool: tool, notificationType: type, message: message));
        _session = s;
        if (change is not null)
        {
            _engine.OnStateChanged(change);
        }
    }

    private IReadOnlyList<NotificationRequest> Poll(DateTimeOffset now) =>
        _engine.Poll(now, _session is null ? [] : [_session]);

    [Fact]
    public void Permission_request_fires_after_settle_delay()
    {
        Event(HookEventKind.UserPromptSubmit, T0);
        Event(HookEventKind.PermissionRequest, T0.AddSeconds(2), tool: "Bash");

        Poll(T0.AddSeconds(2.5)).Should().BeEmpty("still settling");
        var fired = Poll(T0.AddSeconds(3));

        fired.Should().ContainSingle().Which.RuleId.Should().Be(RuleIds.WaitingPermission);
        fired[0].ProjectName.Should().Be("alpha");
    }

    [Fact]
    public void Permission_resolved_within_settle_window_does_not_fire()
    {
        Event(HookEventKind.UserPromptSubmit, T0);
        Event(HookEventKind.PermissionRequest, T0.AddSeconds(1), tool: "Bash");
        Event(HookEventKind.PostToolUse, T0.AddSeconds(1.5));

        Poll(T0.AddSeconds(5)).Should().BeEmpty();
    }

    [Fact]
    public void Same_rule_for_same_session_is_debounced_for_five_seconds()
    {
        Event(HookEventKind.UserPromptSubmit, T0);
        Event(HookEventKind.PermissionRequest, T0.AddSeconds(1), tool: "Bash");
        Poll(T0.AddSeconds(2)).Should().HaveCount(1);

        Event(HookEventKind.PostToolUse, T0.AddSeconds(3));
        Event(HookEventKind.PermissionRequest, T0.AddSeconds(4), tool: "Bash");
        Poll(T0.AddSeconds(5)).Should().BeEmpty("debounced");

        Event(HookEventKind.PostToolUse, T0.AddSeconds(8));
        Event(HookEventKind.PermissionRequest, T0.AddSeconds(9), tool: "Bash");
        Poll(T0.AddSeconds(10)).Should().HaveCount(1);
    }

    [Fact]
    public void Notification_after_permission_request_does_not_duplicate_toast()
    {
        Event(HookEventKind.UserPromptSubmit, T0);
        Event(HookEventKind.PermissionRequest, T0.AddSeconds(1), tool: "Bash");
        Event(HookEventKind.Notification, T0.AddSeconds(7), type: "permission_prompt", message: "Claude needs your permission to use Bash");

        var all = Poll(T0.AddSeconds(2)).Concat(Poll(T0.AddSeconds(10)));
        all.Should().ContainSingle();
    }

    [Fact]
    public void Waiting_input_fires()
    {
        Event(HookEventKind.UserPromptSubmit, T0);
        Event(HookEventKind.Notification, T0.AddSeconds(5), type: "elicitation_dialog", message: "Claude needs your input");

        Poll(T0.AddSeconds(7)).Should().ContainSingle().Which.RuleId.Should().Be(RuleIds.WaitingInput);
    }

    [Fact]
    public void Idle_reminder_after_a_finished_turn_does_not_fire()
    {
        Event(HookEventKind.UserPromptSubmit, T0);
        Event(HookEventKind.Stop, T0.AddSeconds(10));
        Event(HookEventKind.Notification, T0.AddSeconds(70), type: "idle_prompt", message: "Claude is waiting for your input");

        Poll(T0.AddSeconds(72)).Should().NotContain(r => r.RuleId == RuleIds.WaitingInput);
    }

    [Fact]
    public void Long_turn_completion_fires_with_duration()
    {
        Event(HookEventKind.UserPromptSubmit, T0);
        Event(HookEventKind.Stop, T0.AddSeconds(75));

        var fired = Poll(T0.AddSeconds(77));
        fired.Should().ContainSingle();
        fired[0].RuleId.Should().Be(RuleIds.Completed);
        fired[0].Duration.Should().Be(TimeSpan.FromSeconds(75));
    }

    [Fact]
    public void Short_turn_completion_does_not_fire()
    {
        Event(HookEventKind.UserPromptSubmit, T0);
        Event(HookEventKind.Stop, T0.AddSeconds(10));

        Poll(T0.AddSeconds(20)).Should().BeEmpty();
    }

    [Fact]
    public void Disabled_rule_does_not_fire()
    {
        _engine.Options = new RuleOptions { CompletedEnabled = false };
        Event(HookEventKind.UserPromptSubmit, T0);
        Event(HookEventKind.Stop, T0.AddSeconds(120));

        Poll(T0.AddSeconds(130)).Should().BeEmpty();
    }

    [Fact]
    public void Stale_transition_fires()
    {
        var change = SessionStateMachine.Evaluate(Session(SessionState.Working, T0), T0.AddMinutes(11), new FakeEnvironment(), new SessionOptions());
        _session = change.Session;
        _engine.OnStateChanged(change.Change!);

        var fired = Poll(T0.AddMinutes(11).AddSeconds(1));
        fired.Should().ContainSingle().Which.RuleId.Should().Be(RuleIds.Stale);
        fired[0].Duration.Should().Be(TimeSpan.FromMinutes(11));
    }

    [Fact]
    public void Reminder_fires_once_per_waiting_episode()
    {
        Event(HookEventKind.UserPromptSubmit, T0);
        Event(HookEventKind.PermissionRequest, T0.AddSeconds(1), tool: "Bash");
        Poll(T0.AddSeconds(2));

        Poll(T0.AddMinutes(5)).Should().BeEmpty();
        Poll(T0.AddMinutes(10).AddSeconds(1)).Should().ContainSingle().Which.RuleId.Should().Be(RuleIds.WaitingReminder);
        Poll(T0.AddMinutes(20)).Should().BeEmpty("only one reminder per episode");

        // New episode → new reminder.
        Event(HookEventKind.PostToolUse, T0.AddMinutes(21));
        Event(HookEventKind.PermissionRequest, T0.AddMinutes(22), tool: "Bash");
        Poll(T0.AddMinutes(22).AddSeconds(2));
        Poll(T0.AddMinutes(33)).Should().ContainSingle().Which.RuleId.Should().Be(RuleIds.WaitingReminder);
    }

    [Fact]
    public void Reminder_is_not_repeated_after_restart_when_state_is_persisted()
    {
        var store = new InMemoryRuleStateStore();
        var first = new RuleEngine(new RuleOptions(), store);
        Event(HookEventKind.UserPromptSubmit, T0);
        Event(HookEventKind.PermissionRequest, T0.AddSeconds(1), tool: "Bash");

        first.Poll(T0.AddMinutes(11), [_session!]).Should().ContainSingle().Which.RuleId.Should().Be(RuleIds.WaitingReminder);

        // Restart: a new engine, same persisted session (same StateSince) and same store.
        var restarted = new RuleEngine(new RuleOptions(), store);
        restarted.Poll(T0.AddMinutes(12), [_session!]).Should().BeEmpty();

        // A new waiting episode still reminds.
        Event(HookEventKind.PostToolUse, T0.AddMinutes(13));
        Event(HookEventKind.PermissionRequest, T0.AddMinutes(14), tool: "Bash");
        restarted.Poll(T0.AddMinutes(25), [_session!]).Should().ContainSingle().Which.RuleId.Should().Be(RuleIds.WaitingReminder);
    }

    private static readonly RuleOptions UnseenOn = new() { UnseenReminderEnabled = true, CompletedEnabled = false, WaitingReminderEnabled = false };

    /// <summary>A turn that finishes at T0 + 1 min.</summary>
    private void FinishTurn()
    {
        Event(HookEventKind.UserPromptSubmit, T0);
        Event(HookEventKind.Stop, T0.AddMinutes(1));
    }

    [Fact]
    public void Unseen_reminder_is_off_by_default()
    {
        new RuleOptions().UnseenReminderEnabled.Should().BeFalse();
        new RuleOptions().UnseenReminderAfter.Should().Be(TimeSpan.FromMinutes(30));
        new RuleOptions().IsEnabled(RuleIds.UnseenReminder).Should().BeFalse();

        var engine = new RuleEngine(new RuleOptions { CompletedEnabled = false });
        FinishTurn();
        engine.Poll(T0.AddHours(2), [_session!]).Should().BeEmpty();
    }

    [Fact]
    public void Unseen_reminder_fires_once_after_the_wait()
    {
        var engine = new RuleEngine(UnseenOn);
        FinishTurn();

        engine.Poll(T0.AddMinutes(30), [_session!]).Should().BeEmpty("29 minutes since the turn finished");
        var fired = engine.Poll(T0.AddMinutes(31), [_session!]);
        fired.Should().ContainSingle().Which.RuleId.Should().Be(RuleIds.UnseenReminder);
        fired[0].Duration.Should().Be(TimeSpan.FromMinutes(30));
        engine.Poll(T0.AddMinutes(90), [_session!]).Should().BeEmpty("one reminder per finished turn");
    }

    [Fact]
    public void Unseen_reminder_respects_the_configured_wait()
    {
        var engine = new RuleEngine(UnseenOn with { UnseenReminderAfter = TimeSpan.FromMinutes(5) });
        FinishTurn();

        engine.Poll(T0.AddMinutes(5), [_session!]).Should().BeEmpty();
        engine.Poll(T0.AddMinutes(6), [_session!]).Should().ContainSingle().Which.RuleId.Should().Be(RuleIds.UnseenReminder);
    }

    [Fact]
    public void Unseen_reminder_does_not_fire_once_seen()
    {
        var engine = new RuleEngine(UnseenOn);
        FinishTurn();
        _session = SessionStateMachine.MarkSeen(_session!, T0.AddMinutes(10));

        engine.Poll(T0.AddHours(1), [_session!]).Should().BeEmpty();
    }

    [Fact]
    public void Unseen_reminder_fires_again_for_the_next_finished_turn_and_not_after_restart()
    {
        var store = new InMemoryRuleStateStore();
        var engine = new RuleEngine(UnseenOn, store);
        FinishTurn();
        engine.Poll(T0.AddMinutes(31), [_session!]).Should().ContainSingle();

        new RuleEngine(UnseenOn, store).Poll(T0.AddMinutes(40), [_session!]).Should().BeEmpty("persisted per finished turn");

        Event(HookEventKind.UserPromptSubmit, T0.AddMinutes(41));
        Event(HookEventKind.Stop, T0.AddMinutes(42));
        engine.Poll(T0.AddMinutes(73), [_session!]).Should().ContainSingle().Which.RuleId.Should().Be(RuleIds.UnseenReminder);
    }

    [Fact]
    public void Muted_project_does_not_fire_until_mute_expires()
    {
        _engine.MuteProject(@"C:\src\alpha", T0.AddHours(1));
        Event(HookEventKind.UserPromptSubmit, T0);
        Event(HookEventKind.PermissionRequest, T0.AddSeconds(1), tool: "Bash");
        Poll(T0.AddSeconds(3)).Should().BeEmpty();

        Event(HookEventKind.PostToolUse, T0.AddHours(1).AddSeconds(1));
        Event(HookEventKind.PermissionRequest, T0.AddHours(1).AddSeconds(2), tool: "Bash");
        Poll(T0.AddHours(1).AddSeconds(4)).Should().ContainSingle();
    }
}
