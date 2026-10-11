using System.Text;
using Hub.Core.Adapters;
using Hub.Core.Notifications;
using Hub.Core.Sessions;
using Hub.Infrastructure.Adapters;
using Hub.Infrastructure.Claude;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Projects;
using Hub.Infrastructure.Sessions;
using Hub.Service.Hosting;

namespace Hub.Service.Tests;

/// <summary>Events spooled while the hub was down update sessions but raise no notifications when replayed.</summary>
public sealed class EventPipelineReplayTests : IAsyncLifetime
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
        _pipeline = new EventPipeline(_tracker, new RuleEngine(new RuleOptions()), new SessionRepository(db), TimeProvider.System, new ProjectRootResolver(), () => catalog.Registry);
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

    [Fact]
    public async Task Replayed_events_update_the_session_without_notifications()
    {
        Enqueue("s-replay", replayed: true);

        await WaitForStateAsync("s-replay", SessionState.WaitingPermission);
        await Task.Delay(2500); // a few ticks: the final state is old, its settle window long gone
        lock (_fired)
        {
            _fired.Should().BeEmpty();
        }
    }

    [Fact]
    public async Task The_same_events_live_do_notify()
    {
        Enqueue("s-live", replayed: false);

        await WaitForStateAsync("s-live", SessionState.WaitingPermission);
        for (var i = 0; i < 50; i++)
        {
            lock (_fired)
            {
                if (_fired.Count > 0)
                {
                    break;
                }
            }

            await Task.Delay(50);
        }

        lock (_fired)
        {
            _fired.Should().Contain(r => r.RuleId == RuleIds.WaitingPermission && r.SessionId == "s-live");
        }
    }

    /// <summary>Prompt, then a permission request, both two minutes old (below the waiting reminder delay).</summary>
    private void Enqueue(string sessionId, bool replayed)
    {
        var at = DateTimeOffset.UtcNow.AddMinutes(-2);
        _pipeline.EnqueueHook(Envelope(sessionId, "UserPromptSubmit", at), replayed);
        _pipeline.EnqueueHook(Envelope(sessionId, "PermissionRequest", at.AddSeconds(5)), replayed);
    }

    private static byte[] Envelope(string sessionId, string hookEvent, DateTimeOffset at) =>
        Encoding.UTF8.GetBytes(
            $$"""{"v":1,"agent":"claude-code","event":"{{hookEvent}}","tsMs":{{at.ToUnixTimeMilliseconds()}},"payload":{"session_id":"{{sessionId}}","cwd":"C:/src/alpha","tool_name":"Bash","tool_input":{"command":"ls"} } }""");

    private async Task WaitForStateAsync(string sessionId, SessionState state)
    {
        for (var i = 0; i < 50; i++)
        {
            if (_tracker.Snapshot.Any(s => s.SessionId == sessionId && s.State == state))
            {
                return;
            }

            await Task.Delay(50);
        }

        _tracker.Snapshot.Should().Contain(s => s.SessionId == sessionId && s.State == state);
    }
}
