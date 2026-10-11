using System.Net;
using System.Text.Json;
using Hub.Contracts;
using Hub.Core.Adapters;
using Hub.Core.Notifications;
using Hub.Core.Sessions;
using Hub.Infrastructure.Adapters;
using Hub.Infrastructure.Claude;
using Hub.Infrastructure.Codex;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Projects;
using Hub.Infrastructure.Sessions;
using Hub.Service.Hosting;

namespace Hub.Service.Tests;

public sealed class IngestServerTests : IAsyncLifetime
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "agenthub-tests", Guid.NewGuid().ToString("N"));
    private readonly HttpClient _http = new();
    private EventPipeline _pipeline = null!;
    private IngestServer _server = null!;
    private PortFile _portFile = null!;

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(_dir);
        var db = new Database(Path.Combine(_dir, "hub.db"));
        db.Migrate();
        var tracker = new SessionTracker(new SessionEnvironment(), new SessionOptions());
        var rules = new RuleEngine(new RuleOptions(), new NotificationLogStore(db));
        var hookExe = Path.Combine(_dir, "bin", "agenthub-hook.exe");
        var catalog = new AdapterCatalog(
            [
                new AgentIntegration(new ClaudeCodeAdapter(), new ClaudeSettingsMerger(Path.Combine(_dir, "claude", "settings.json"), hookExe)),
                new AgentIntegration(new CodexAdapter(), new CodexHooksMerger(Path.Combine(_dir, "codex", "hooks.json"), Path.Combine(_dir, "codex", "config.toml"), hookExe)),
            ],
            builtInDir: null,
            userDir: null);
        _pipeline = new EventPipeline(tracker, rules, new SessionRepository(db), TimeProvider.System, new ProjectRootResolver(), () => catalog.Registry);
        _pipeline.Start();
        _server = new IngestServer(_pipeline, () => tracker.Snapshot, () => UsageSnapshot.Empty);
        _server.Modules.Add(app => Hub.Service.Api.AdapterEndpoints.Map(app, catalog));

        var portPath = Path.Combine(_dir, HubApi.PortFileName);
        (await _server.StartAsync(portPath, CancellationToken.None)).Should().BeTrue();
        _portFile = PortFile.Parse(await File.ReadAllTextAsync(portPath))!;
    }

    public async Task DisposeAsync()
    {
        _http.Dispose();
        await _server.DisposeAsync();
        await _pipeline.DisposeAsync();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        Directory.Delete(_dir, recursive: true);
    }

    [Fact]
    public void Port_file_has_the_bound_port_and_token()
    {
        _portFile.Should().NotBeNull();
        _portFile.Port.Should().Be(_server.Port);
        _portFile.Token.Should().Be(_server.Token).And.HaveLength(64);
        _portFile.Pid.Should().Be(Environment.ProcessId);
    }

    [Fact]
    public async Task Health_requires_the_token()
    {
        using var response = await _http.GetAsync(Url("/v1/health"));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Health_rejects_a_wrong_token()
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, Url("/v1/health"));
        request.Headers.Add(HubApi.TokenHeader, new string('0', 64));

        using var response = await _http.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Health_answers_with_the_token()
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, Url("/v1/health"));
        request.Headers.Add(HubApi.TokenHeader, _portFile.Token);

        using var response = await _http.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await response.Content.ReadAsStringAsync()).Should().Contain("\"status\":\"ok\"");
    }

    [Fact]
    public async Task Browser_requests_are_rejected_even_with_the_token()
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, Url("/v1/events")) { Content = new StringContent("{}") };
        request.Headers.Add(HubApi.TokenHeader, _portFile.Token);
        request.Headers.Add("Origin", "https://example.com");

        using var response = await _http.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Events_are_accepted_with_the_token()
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, Url("/v1/events")) { Content = new StringContent("{}") };
        request.Headers.Add(HubApi.TokenHeader, _portFile.Token);

        using var response = await _http.SendAsync(request);

        response.StatusCode.Should().Be(HttpStatusCode.Accepted);
    }

    [Fact]
    public async Task Adapters_list_both_agents_with_their_hook_state()
    {
        using var doc = JsonDocument.Parse(await SendAsync(HttpMethod.Get, "/v1/adapters", HttpStatusCode.OK));

        var items = doc.RootElement.EnumerateArray().ToList();
        items.Select(i => i.GetProperty("id").GetString()).Should().Equal("claude-code", "codex");
        items[1].GetProperty("displayName").GetString().Should().Be("Codex CLI");
        items[1].GetProperty("hooks").GetProperty("state").GetString().Should().Be("missing");
        items[1].GetProperty("hooks").GetProperty("configPath").GetString().Should().EndWith("hooks.json");
    }

    [Fact]
    public async Task Install_and_uninstall_change_the_state()
    {
        using var installed = JsonDocument.Parse(await SendAsync(HttpMethod.Post, "/v1/adapters/codex/hooks/install", HttpStatusCode.OK));
        installed.RootElement.GetProperty("state").GetString().Should().Be("installed");
        installed.RootElement.GetProperty("needsApproval").GetBoolean().Should().BeTrue();
        File.Exists(Path.Combine(_dir, "codex", "hooks.json")).Should().BeTrue();

        using var removed = JsonDocument.Parse(await SendAsync(HttpMethod.Post, "/v1/adapters/codex/hooks/uninstall", HttpStatusCode.OK));
        removed.RootElement.GetProperty("state").GetString().Should().Be("missing");
        removed.RootElement.GetProperty("backupPath").GetString().Should().NotBeNullOrEmpty();
    }

    [Fact]
    public async Task Unreadable_agent_config_is_422_and_left_untouched()
    {
        var settings = Path.Combine(_dir, "claude", "settings.json");
        Directory.CreateDirectory(Path.GetDirectoryName(settings)!);
        await File.WriteAllTextAsync(settings, "{ not json");

        using var doc = JsonDocument.Parse(await SendAsync(HttpMethod.Post, "/v1/adapters/claude-code/hooks/install", HttpStatusCode.UnprocessableEntity));

        doc.RootElement.GetProperty("error").GetString().Should().Be("invalidConfig");
        (await File.ReadAllTextAsync(settings)).Should().Be("{ not json");
    }

    [Fact]
    public async Task Unknown_adapter_is_404() =>
        await SendAsync(HttpMethod.Post, "/v1/adapters/nope/hooks/install", HttpStatusCode.NotFound);

    [Fact]
    public async Task Sessions_report_agent_and_pane()
    {
        var envelope = """{"agent":"codex","event":"UserPromptSubmit","paneId":"pane-9","payload":{"session_id":"s-1","cwd":"C:/src/beta"}}""";
        using (var request = new HttpRequestMessage(HttpMethod.Post, Url("/v1/events")) { Content = new StringContent(envelope) })
        {
            request.Headers.Add(HubApi.TokenHeader, _portFile.Token);
            using var accepted = await _http.SendAsync(request);
            accepted.StatusCode.Should().Be(HttpStatusCode.Accepted);
        }

        JsonElement session = default;
        for (var i = 0; i < 50 && session.ValueKind == JsonValueKind.Undefined; i++)
        {
            await Task.Delay(50);
            using var doc = JsonDocument.Parse(await SendAsync(HttpMethod.Get, "/v1/sessions", HttpStatusCode.OK));
            session = doc.RootElement.EnumerateArray().Select(e => e.Clone()).FirstOrDefault();
        }

        session.GetProperty("agent").GetString().Should().Be("codex");
        session.GetProperty("paneId").GetString().Should().Be("pane-9");
        session.GetProperty("state").GetString().Should().Be("Working");
    }

    private async Task<string> SendAsync(HttpMethod method, string path, HttpStatusCode expected)
    {
        using var request = new HttpRequestMessage(method, Url(path));
        request.Headers.Add(HubApi.TokenHeader, _portFile.Token);
        using var response = await _http.SendAsync(request);
        response.StatusCode.Should().Be(expected);
        return await response.Content.ReadAsStringAsync();
    }

    private Uri Url(string path) => new($"http://127.0.0.1:{_portFile.Port}{path}");
}
