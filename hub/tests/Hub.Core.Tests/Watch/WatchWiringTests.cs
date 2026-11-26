using System.Globalization;
using System.Text;
using Hub.Core.Activity;
using Hub.Core.Hooks;
using Hub.Core.Notifications;
using Hub.Core.Sessions;
using Hub.Core.Watch;
using static Hub.Core.Tests.TestData;

namespace Hub.Core.Tests.Watch;

/// <summary>Where a watch hit is evaluated (timeline), carried (state machine) and announced (rule engine).</summary>
public class WatchWiringTests
{
    private const string Root = @"C:\src\alpha";
    private static readonly WatchHit Hit = new("builtin.secret-file", "Secret file");

    private static HookEvent Ev(string agent, string name, string payload, double seconds = 0)
    {
        var at = T0.AddSeconds(seconds).ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
        var json = $$$"""{"v":1,"agent":"{{{agent}}}","event":"{{{name}}}","receivedAt":"{{{at}}}","payload":{{{payload}}}}""";
        var e = HookEventParser.Parse(Encoding.UTF8.GetBytes(json), TestAdapters.BuiltIn, out var error);
        error.Should().Be(HookParseError.None, json);
        return e!;
    }

    private sealed class Counter
    {
        public int Calls { get; private set; }

        public Func<WatchHit?> Evaluate => () =>
        {
            Calls++;
            return Hit;
        };
    }

    // ---- evaluated once per timeline row ----

    [Fact]
    public void Claude_is_evaluated_on_PreToolUse_only_not_on_permission_request_or_post()
    {
        var tracker = new ActivityTracker();
        var counter = new Counter();
        tracker.ObserveWatched(Ev("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"cat .env"}}"""), Root, counter.Evaluate);
        tracker.ObserveWatched(Ev("claude-code", "PermissionRequest", """{"session_id":"s1","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"cat .env"}}""", 1), Root, counter.Evaluate);
        tracker.ObserveWatched(Ev("claude-code", "PostToolUse", """{"session_id":"s1","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"cat .env"}}""", 2), Root, counter.Evaluate);

        counter.Calls.Should().Be(1);
        tracker.Get("claude-code", "s1")!.Entries.Should().ContainSingle().Which.Watch.Should().Be(Hit);
    }

    [Fact]
    public void An_agent_without_tool_use_ids_is_evaluated_once_per_call()
    {
        var tracker = new ActivityTracker();
        var counter = new Counter();
        tracker.ObserveWatched(Ev("gemini", "BeforeTool", """{"session_id":"s1","tool_name":"run_shell_command","tool_input":{"command":"cat .env"}}"""), Root, counter.Evaluate);
        tracker.ObserveWatched(Ev("gemini", "AfterTool", """{"session_id":"s1","tool_name":"run_shell_command","tool_input":{"command":"cat .env"}}""", 1), Root, counter.Evaluate);
        tracker.ObserveWatched(Ev("gemini", "BeforeTool", """{"session_id":"s1","tool_name":"run_shell_command","tool_input":{"command":"ls"}}""", 2), Root, counter.Evaluate);
        tracker.ObserveWatched(Ev("gemini", "AfterTool", """{"session_id":"s1","tool_name":"run_shell_command","tool_input":{"command":"ls"}}""", 3), Root, counter.Evaluate);

        counter.Calls.Should().Be(2, "two calls, two rows");
        tracker.Get("gemini", "s1")!.Entries.Should().HaveCount(2);
    }

    [Fact]
    public void A_codex_permission_request_that_starts_the_row_is_evaluated_and_the_following_pre_is_not()
    {
        var tracker = new ActivityTracker();
        var counter = new Counter();
        tracker.ObserveWatched(Ev("codex", "PermissionRequest", """{"session_id":"s1","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}"""), Root, counter.Evaluate);
        tracker.ObserveWatched(Ev("codex", "PreToolUse", """{"session_id":"s1","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}""", 1), Root, counter.Evaluate);

        counter.Calls.Should().Be(1);
    }

    [Fact]
    public void A_post_only_agent_is_evaluated_on_the_event_that_creates_the_row_and_not_on_its_duplicate()
    {
        var tracker = new ActivityTracker();
        var counter = new Counter();
        tracker.ObserveWatched(Ev("cursor", "postToolUse", """{"conversation_id":"c1","workspace_roots":["C:/src/alpha"],"tool_name":"Shell","tool_input":{"command":"cat .env"},"tool_use_id":"tool_01","duration":5130}"""), Root, counter.Evaluate);
        tracker.ObserveWatched(Ev("cursor", "afterShellExecution", """{"conversation_id":"c1","command":"cat .env","duration":5120}""", 0.2), Root, counter.Evaluate);

        tracker.Get("cursor", "c1")!.Entries.Should().ContainSingle();
        counter.Calls.Should().Be(1, "the duplicate postToolUse / afterShellExecution pair is one call");
    }

    [Fact]
    public void Events_that_start_no_row_are_not_evaluated()
    {
        var tracker = new ActivityTracker();
        var counter = new Counter();
        tracker.ObserveWatched(Ev("claude-code", "UserPromptSubmit", """{"session_id":"s1","prompt_length":3}"""), Root, counter.Evaluate);
        tracker.ObserveWatched(Ev("claude-code", "Stop", """{"session_id":"s1"}""", 1), Root, counter.Evaluate);

        counter.Calls.Should().Be(0);
    }

    // ---- carried to the permission card ----

    [Fact]
    public void A_card_built_from_a_Claude_notification_carries_the_hit_of_the_running_tool()
    {
        var (s, _) = SessionStateMachine.Apply(null, Hook(HookEventKind.UserPromptSubmit, T0));
        (s, _) = SessionStateMachine.Apply(s, Hook(HookEventKind.PreToolUse, T0.AddSeconds(1), tool: "Bash"));

        (s, _) = SessionStateMachine.Apply(
            s, Hook(HookEventKind.Notification, T0.AddSeconds(2), notificationType: "permission_prompt", message: "Claude needs your permission to use Bash") with { Watch = Hit });

        s.State.Should().Be(SessionState.WaitingPermission);
        s.PendingPermission!.Watch.Should().Be(Hit);
    }

    [Fact]
    public void A_permission_request_reports_the_hit_of_the_row_it_resolves_to()
    {
        var tracker = new ActivityTracker();
        var counter = new Counter();
        tracker.ObserveWatched(Ev("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"cat .env"}}"""), Root, counter.Evaluate);

        var result = tracker.ObserveWatched(Ev("claude-code", "PermissionRequest", """{"session_id":"s1","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"cat .env"}}""", 1), Root, counter.Evaluate);

        result.Watch.Should().Be(Hit);
        result.Evaluated.Should().BeFalse("the row was judged on its PreToolUse");
    }

    [Fact]
    public void The_permission_notification_takes_the_hit_of_the_newest_running_row_and_not_of_a_parallel_one()
    {
        var tracker = new ActivityTracker();
        var hits = new Queue<WatchHit?>([Hit, null]);
        tracker.ObserveWatched(Ev("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"cat .env"}}"""), Root, hits.Dequeue);
        tracker.ObserveWatched(Ev("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"Read","tool_use_id":"t2","tool_input":{"file_path":"a.txt"}}""", 1), Root, hits.Dequeue);

        var notification = tracker.ObserveWatched(
            Ev("claude-code", "Notification", """{"session_id":"s1","notification_type":"permission_prompt","message":"Claude needs your permission to use Read"}""", 2), Root, () => Hit);

        notification.Watch.Should().BeNull("the newest running tool (Read) asks, and it matched nothing");
        notification.Evaluated.Should().BeFalse();
    }

    [Fact]
    public void A_permission_request_that_opened_its_own_row_without_a_hit_has_no_badge()
    {
        var tracker = new ActivityTracker();
        tracker.ObserveWatched(Ev("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"cat .env"}}"""), Root, () => Hit);

        var result = tracker.ObserveWatched(
            Ev("claude-code", "PermissionRequest", """{"session_id":"s1","tool_name":"Read","tool_use_id":"t2","tool_input":{"file_path":"a.txt"}}""", 1), Root, () => null);

        result.Evaluated.Should().BeTrue();
        result.Watch.Should().BeNull();
    }

    [Fact]
    public void The_hit_is_stored_on_the_row_and_the_evaluation_runs_outside_the_tracker_lock()
    {
        var tracker = new ActivityTracker();
        ActivitySnapshot? seen = null;
        var result = tracker.ObserveWatched(
            Ev("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"cat .env"}}"""),
            Root,
            () =>
            {
                // Another thread can read the tracker meanwhile, so the callback does not run under its lock.
                var read = Task.Run(() => tracker.Get("claude-code", "s1"));
                read.Wait(TimeSpan.FromSeconds(5)).Should().BeTrue("the tracker lock is free while the rules run");
                seen = read.Result;
                return Hit;
            });

        result.Watch.Should().Be(Hit);
        seen.Should().NotBeNull();
        seen!.Entries.Should().ContainSingle().Which.Watch.Should().BeNull("not stored until the evaluation returns");
        tracker.DrainChanges().Single().Entries.Should().ContainSingle().Which.Watch.Should().Be(Hit, "the same frame carries the hit");
    }

    [Fact]
    public void A_permission_request_that_was_itself_matched_carries_its_own_hit()
    {
        var (s, _) = SessionStateMachine.Apply(null, Hook(HookEventKind.UserPromptSubmit, T0));
        (s, _) = SessionStateMachine.Apply(s, Hook(HookEventKind.PermissionRequest, T0.AddSeconds(1), tool: "Bash") with { Watch = Hit });
        s.PendingPermission!.Watch.Should().Be(Hit);
    }

    // ---- notifications ----

    private readonly RuleEngine _rules = new(new RuleOptions());

    private static SessionInfo Waiting(SessionState state, WatchHit? pendingHit = null, string? lastNotification = null) =>
        Session(state, T0) with
        {
            LastNotification = lastNotification,
            PendingPermission = pendingHit is null ? null : new PermissionPrompt("Bash", null, null, null, T0) { Watch = pendingHit },
        };

    [Fact]
    public void A_match_fires_watch_matched_after_the_settle_delay_with_rule_and_tool()
    {
        _rules.OnWatchMatched("s1", Hit, "Read", T0);

        _rules.Poll(T0.AddSeconds(2), [Session(SessionState.Working, T0)]).Should().BeEmpty("still settling");
        var fired = _rules.Poll(T0.AddSeconds(3), [Session(SessionState.Working, T0)]).Should().ContainSingle().Subject;

        fired.RuleId.Should().Be(RuleIds.WatchMatched);
        fired.Message.Should().Be("Secret file · Read");
        fired.ProjectName.Should().Be("alpha");
    }

    [Fact]
    public void Notifications_are_limited_to_one_per_session_and_rule_per_five_minutes()
    {
        var working = Session(SessionState.Working, T0);
        _rules.OnWatchMatched("s1", Hit, "Read", T0);
        _rules.Poll(T0.AddSeconds(3), [working]).Should().HaveCount(1);

        _rules.OnWatchMatched("s1", Hit, "Read", T0.AddMinutes(1));
        _rules.Poll(T0.AddMinutes(1).AddSeconds(3), [working]).Should().BeEmpty("same session and rule within five minutes");

        _rules.OnWatchMatched("s1", new WatchHit("builtin.force-push", "Force push"), "Bash", T0.AddMinutes(2));
        _rules.Poll(T0.AddMinutes(2).AddSeconds(3), [working]).Should().ContainSingle("another rule has its own window");

        _rules.OnWatchMatched("s2", Hit, "Read", T0.AddMinutes(2));
        _rules.Poll(T0.AddMinutes(2).AddSeconds(3), [Session(SessionState.Working, T0, id: "s2")]).Should().ContainSingle("another session");

        _rules.OnWatchMatched("s1", Hit, "Read", T0.AddMinutes(5));
        _rules.Poll(T0.AddMinutes(5).AddSeconds(3), [working]).Should().ContainSingle("the window is over");
    }

    [Fact]
    public void A_match_that_became_a_permission_card_adds_the_rule_name_to_the_permission_toast_instead()
    {
        _rules.OnWatchMatched("s1", Hit, "Bash", T0);
        var waiting = Waiting(SessionState.WaitingPermission, Hit, "Claude needs your permission");

        var fired = _rules.Poll(T0.AddSeconds(3), [waiting]);

        fired.Should().BeEmpty("no separate watch.matched");

        // The permission toast itself: its message names the rule.
        var (s, change) = SessionStateMachine.Apply(null, Hook(HookEventKind.UserPromptSubmit, T0));
        (s, change) = SessionStateMachine.Apply(s, Hook(HookEventKind.PreToolUse, T0.AddSeconds(1), tool: "Bash") with { Watch = Hit });
        (s, change) = SessionStateMachine.Apply(
            s, Hook(HookEventKind.Notification, T0.AddSeconds(2), notificationType: "permission_prompt", message: "Claude needs your permission to use Bash") with { Watch = Hit });
        _rules.OnStateChanged(change!);
        var permission = _rules.Poll(T0.AddSeconds(4), [s]).Should().ContainSingle().Subject;
        permission.RuleId.Should().Be(RuleIds.WaitingPermission);
        permission.Message.Should().Be("Claude needs your permission to use Bash · Secret file");
    }

    [Fact]
    public void A_permission_toast_without_a_hit_keeps_the_plain_message()
    {
        var (s, change) = SessionStateMachine.Apply(null, Hook(HookEventKind.UserPromptSubmit, T0));
        (s, change) = SessionStateMachine.Apply(
            s, Hook(HookEventKind.Notification, T0.AddSeconds(2), notificationType: "permission_prompt", message: "Claude needs your permission to use Bash"));
        _rules.OnStateChanged(change!);

        _rules.Poll(T0.AddSeconds(4), [s]).Should().ContainSingle().Which.Message.Should().Be("Claude needs your permission to use Bash");
    }

    [Fact]
    public void A_permission_answered_within_the_settle_does_not_leave_a_second_watch_toast_behind()
    {
        var (s, _) = SessionStateMachine.Apply(null, Hook(HookEventKind.UserPromptSubmit, T0));
        (s, _) = SessionStateMachine.Apply(s, Hook(HookEventKind.PreToolUse, T0.AddSeconds(1), tool: "Bash"));
        _rules.OnWatchMatched(s.SessionId, Hit, "Bash", T0.AddSeconds(1));
        var (waiting, change) = SessionStateMachine.Apply(
            s, Hook(HookEventKind.Notification, T0.AddSeconds(1.5), notificationType: "permission_prompt", message: "Claude needs your permission to use Bash") with { Watch = Hit });
        _rules.OnStateChanged(change!);

        // Answered at once: the session is working again before the 3 s settle ends.
        var (answered, _) = SessionStateMachine.Apply(waiting, Hook(HookEventKind.PostToolUse, T0.AddSeconds(2)));

        _rules.Poll(T0.AddSeconds(5), [answered]).Should().NotContain(r => r.RuleId == RuleIds.WatchMatched);
    }

    [Fact]
    public void A_match_in_a_session_that_waits_for_something_else_still_notifies()
    {
        _rules.OnWatchMatched("s1", Hit, "Bash", T0);
        var waiting = Waiting(SessionState.WaitingPermission, new WatchHit("builtin.force-push", "Force push"));

        _rules.Poll(T0.AddSeconds(3), [waiting]).Should().ContainSingle().Which.RuleId.Should().Be(RuleIds.WatchMatched);
    }

    [Fact]
    public void A_muted_session_rule_stays_silent()
    {
        _rules.MuteSessionRule("s1", RuleIds.WatchMatched);
        _rules.OnWatchMatched("s1", Hit, "Read", T0);

        _rules.Poll(T0.AddSeconds(3), [Session(SessionState.Working, T0)]).Should().BeEmpty();
    }
}
