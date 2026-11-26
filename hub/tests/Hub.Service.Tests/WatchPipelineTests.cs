using System.Text;
using Hub.Core.Adapters;
using Hub.Core.Notifications;
using Hub.Core.Sessions;
using Hub.Core.Watch;
using Hub.Infrastructure.Adapters;
using Hub.Infrastructure.Claude;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Projects;
using Hub.Infrastructure.Sessions;
using Hub.Service.Hosting;

namespace Hub.Service.Tests;

/// <summary>Watch rules through the real event pipeline: where they are evaluated, what they notify, what they skip.</summary>
public sealed class WatchPipelineTests : IAsyncLifetime
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "agenthub-tests", Guid.NewGuid().ToString("N"));
    private readonly List<NotificationRequest> _fired = [];
    private SessionTracker _tracker = null!;
    private EventPipeline _pipeline = null!;

    public Task InitializeAsync()
    {
        Directory.CreateDirectory(_dir);
        var db = new Database(Path.Combine(_dir, "hub.db"));
        db.Migrate();
        _tracker = new SessionTracker(new SessionEnvironment(), new SessionOptions());
        var catalog = new AdapterCatalog(
            [new AgentIntegration(new ClaudeCodeAdapter(), new ClaudeSettingsMerger(Path.Combine(_dir, "settings.json"), Path.Combine(_dir, "agenthub-hook.exe")))],
            builtInDir: null,
            userDir: null);
        _pipeline = new EventPipeline(
            _tracker, new RuleEngine(new RuleOptions()), new SessionRepository(db), TimeProvider.System, new ProjectRootResolver(), () => catalog.Registry,
            new WatchService());
        _pipeline.NotificationRequested += r =>
        {
            lock (_fired)
            {
                _fired.Add(r);
            }
        };
        _pipeline.Start();
        return Task.CompletedTask;
    }

    public async Task DisposeAsync()
    {
        await _pipeline.DisposeAsync();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        Directory.Delete(_dir, recursive: true);
    }

    private static byte[] Envelope(string sessionId, string hookEvent, DateTimeOffset at, string? command = null, string? extra = null) =>
        Encoding.UTF8.GetBytes(
            $$"""{"v":1,"agent":"claude-code","event":"{{hookEvent}}","tsMs":{{at.ToUnixTimeMilliseconds()}},"payload":{"session_id":"{{sessionId}}","cwd":"C:/src/alpha","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"{{command ?? "ls"}}"}{{extra}} } }""");

    private void Run(string sessionId, bool replayed, string command, bool permission, DateTimeOffset at)
    {
        _pipeline.EnqueueHook(Envelope(sessionId, "UserPromptSubmit", at), replayed);
        _pipeline.EnqueueHook(Envelope(sessionId, "PreToolUse", at.AddMilliseconds(100), command), replayed);
        if (permission)
        {
            _pipeline.EnqueueHook(Envelope(sessionId, "PermissionRequest", at.AddMilliseconds(200), command), replayed);
        }
    }

    private List<NotificationRequest> Fired()
    {
        lock (_fired)
        {
            return [.. _fired];
        }
    }

    private static async Task<bool> WaitAsync(Func<bool> condition, int milliseconds = 8000)
    {
        for (var waited = 0; waited < milliseconds; waited += 50)
        {
            if (condition())
            {
                return true;
            }

            await Task.Delay(50);
        }

        return condition();
    }

    [Fact]
    public async Task A_matching_call_marks_the_timeline_row_and_notifies_after_the_settle_delay()
    {
        Run("s-live", replayed: false, "cat .env", permission: false, DateTimeOffset.UtcNow);

        (await WaitAsync(() => Fired().Any(r => r.RuleId == RuleIds.WatchMatched))).Should().BeTrue();
        var toast = Fired().Single(r => r.RuleId == RuleIds.WatchMatched);
        toast.SessionId.Should().Be("s-live");
        toast.Message.Should().Be("Secret file · Bash");
        toast.Message.Should().NotContain(".env", "the command never reaches a notification");

        var rows = _pipeline.Activity.Get("claude-code", "s-live")!.Entries;
        rows.Single(e => e.Tool == "Bash").Watch.Should().BeEquivalentTo(new { Id = WatchBuiltins.SecretFile, Name = "Secret file" });
    }

    [Fact]
    public async Task A_call_that_matches_nothing_is_silent()
    {
        Run("s-quiet", replayed: false, "dotnet test", permission: false, DateTimeOffset.UtcNow);
        await Task.Delay(4500);

        Fired().Should().NotContain(r => r.RuleId == RuleIds.WatchMatched);
        _pipeline.Activity.Get("claude-code", "s-quiet")!.Entries.Should().OnlyContain(e => e.Watch == null);
    }

    [Fact]
    public async Task Replayed_events_get_the_mark_but_no_notification()
    {
        Run("s-replay", replayed: true, "cat .env", permission: false, DateTimeOffset.UtcNow.AddMinutes(-2));
        (await WaitAsync(() => _pipeline.Activity.Get("claude-code", "s-replay")?.Entries.Any(e => e.Watch is not null) == true)).Should().BeTrue();
        await Task.Delay(4500);

        Fired().Should().BeEmpty();
    }

    [Fact]
    public async Task A_matched_permission_request_shows_the_rule_on_the_card_and_in_the_permission_toast_without_a_second_toast()
    {
        Run("s-perm", replayed: false, "git push --force origin main", permission: true, DateTimeOffset.UtcNow);

        (await WaitAsync(() => _tracker.Snapshot.Any(s => s.SessionId == "s-perm" && s.State == SessionState.WaitingPermission))).Should().BeTrue();
        _tracker.Snapshot.Single(s => s.SessionId == "s-perm").PendingPermission!.Watch!.Id.Should().Be(WatchBuiltins.ForcePush);
        (await WaitAsync(() => Fired().Any(r => r.RuleId == RuleIds.WaitingPermission))).Should().BeTrue();
        await Task.Delay(3500);

        var toasts = Fired();
        toasts.Should().NotContain(r => r.RuleId == RuleIds.WatchMatched);
        toasts.Single(r => r.RuleId == RuleIds.WaitingPermission).Message.Should().Contain("Force push");
    }
}
