using System.Text;
using Hub.Core.Adapters;
using Hub.Core.Notifications;
using Hub.Core.Sessions;
using Hub.Infrastructure.Adapters;
using Hub.Infrastructure.Claude;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Projects;
using Hub.Service.Hosting;

namespace Hub.Service.Tests;

/// <summary>Changes found by the periodic check (process exit) reach clients even when the session count stays the same.</summary>
public sealed class EventPipelineTickTests : IAsyncLifetime
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "agenthub-tests", Guid.NewGuid().ToString("N"));
    private readonly FakeEnvironment _env = new();
    private readonly List<IReadOnlyList<SessionInfo>> _published = [];
    private SessionTracker _tracker = null!;
    private EventPipeline _pipeline = null!;

    public Task InitializeAsync()
    {
        Directory.CreateDirectory(_dir);
        var db = new Database(Path.Combine(_dir, "hub.db"));
        db.Migrate();
        _tracker = new SessionTracker(_env, new SessionOptions());
        var catalog = new AdapterCatalog(
            [new AgentIntegration(new ClaudeCodeAdapter(), new ClaudeSettingsMerger(Path.Combine(_dir, "settings.json"), Path.Combine(_dir, "agenthub-hook.exe")))],
            builtInDir: null,
            userDir: null);
        _pipeline = new EventPipeline(_tracker, new RuleEngine(new RuleOptions()), new SessionRepository(db), TimeProvider.System, new ProjectRootResolver(), () => catalog.Registry);
        _pipeline.SessionsChanged += sessions =>
        {
            lock (_published)
            {
                _published.Add(sessions);
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
    public async Task A_process_exit_found_by_the_check_is_published()
    {
        _pipeline.EnqueueHook(Envelope("s-exit", "UserPromptSubmit", DateTimeOffset.UtcNow), replayed: false);
        await WaitAsync(() => _tracker.Snapshot.Any(s => s.SessionId == "s-exit"));

        _env.Alive = false;

        // The session check runs every 5 s; the count stays 1 (Ended sessions remain visible for 30 min).
        await WaitAsync(() => Published().Any(p => p.Any(s => s.SessionId == "s-exit" && s.State == SessionState.Ended)), seconds: 10);
        _tracker.Snapshot.Should().ContainSingle(s => s.SessionId == "s-exit").Which.State.Should().Be(SessionState.Ended);
    }

    private List<IReadOnlyList<SessionInfo>> Published()
    {
        lock (_published)
        {
            return [.. _published];
        }
    }

    private static byte[] Envelope(string sessionId, string hookEvent, DateTimeOffset at) =>
        Encoding.UTF8.GetBytes(
            $$"""{"v":1,"agent":"claude-code","event":"{{hookEvent}}","tsMs":{{at.ToUnixTimeMilliseconds()}},"parentPid":4242,"payload":{"session_id":"{{sessionId}}","cwd":"C:/src/alpha"} }""");

    private static async Task WaitAsync(Func<bool> condition, int seconds = 3)
    {
        var until = DateTime.UtcNow.AddSeconds(seconds);
        while (!condition() && DateTime.UtcNow < until)
        {
            await Task.Delay(50);
        }

        condition().Should().BeTrue();
    }

    private sealed class FakeEnvironment : ISessionEnvironment
    {
        public volatile bool Alive = true;

        public DateTimeOffset? GetTranscriptLastWrite(string? transcriptPath) => null;

        public bool IsProcessAlive(int pid) => Alive;
    }
}
