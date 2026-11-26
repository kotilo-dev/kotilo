using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Hub.Contracts;
using Hub.Infrastructure;
using Hub.Service.Hosting;
using Serilog;
using Serilog.Core;
using Serilog.Events;

namespace Hub.Service.Tests;

/// <summary>
/// <c>/v1/watch</c> end to end on a real hub, and AGENTS.md rule 5: a command that matched a rule appears in no log line and
/// no SQLite file. Logging is captured from before the host starts, so every line the hub writes is seen.
/// </summary>
public sealed class WatchApiTests : IAsyncLifetime
{
    private const string Marker = "ZZ-MARKER-9137-qq";

    private sealed class Capture : ILogEventSink
    {
        public StringBuilder Text { get; } = new();

        public void Emit(LogEvent logEvent)
        {
            lock (Text)
            {
                Text.AppendLine(logEvent.RenderMessage(System.Globalization.CultureInfo.InvariantCulture));
                if (logEvent.Exception is { } ex)
                {
                    Text.AppendLine(ex.ToString());
                }

                foreach (var p in logEvent.Properties)
                {
                    Text.AppendLine(string.Concat(p.Key, "=", p.Value.ToString()));
                }
            }
        }

        public string Snapshot()
        {
            lock (Text)
            {
                return Text.ToString();
            }
        }
    }

    private readonly string _dir = Path.Combine(Path.GetTempPath(), "agenthub-tests", Guid.NewGuid().ToString("N"));
    private readonly Capture _log = new();
    private readonly HttpClient _http = new();
    private ILogger _previousLogger = null!;
    private AppHost _host = null!;
    private AppPaths _paths = null!;

    public async Task InitializeAsync()
    {
        _previousLogger = Log.Logger;
        Log.Logger = new LoggerConfiguration().MinimumLevel.Verbose().WriteTo.Sink(_log).CreateLogger();
        _paths = new AppPaths(Path.Combine(_dir, "data"), Path.Combine(_dir, "claude"), Path.Combine(_dir, "codex"));
        _host = AppHost.Create(_paths);
        await _host.StartAsync(CancellationToken.None);
        var port = PortFile.Parse(await File.ReadAllTextAsync(_paths.PortFile))!;
        _http.BaseAddress = new Uri($"http://127.0.0.1:{port.Port}");
        _http.DefaultRequestHeaders.Add(HubApi.TokenHeader, port.Token);
    }

    public async Task DisposeAsync()
    {
        _http.Dispose();
        await _host.DisposeAsync();
        Log.Logger = _previousLogger;
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private async Task<JsonElement> GetAsync(string path) => await _http.GetFromJsonAsync<JsonElement>(path);

    private static async Task<JsonElement> WaitForAsync(Func<Task<JsonElement>> probe)
    {
        for (var i = 0; i < 80; i++)
        {
            var value = await probe();
            if (value.ValueKind != JsonValueKind.Undefined)
            {
                return value;
            }

            await Task.Delay(100);
        }

        throw new TimeoutException("condition not met");
    }

    private async Task<HttpResponseMessage> PutSettingsAsync(Action<JsonObject> change)
    {
        var node = JsonNode.Parse((await GetAsync("/v1/settings")).GetRawText())!.AsObject();
        change(node);
        return await _http.PutAsync("/v1/settings", new StringContent(node.ToJsonString(), Encoding.UTF8, "application/json"));
    }

    [Fact]
    public async Task Defaults_list_the_six_builtins_with_nothing_else()
    {
        var watch = await GetAsync("/v1/watch");

        watch.GetProperty("builtins").EnumerateArray().Select(b => b.GetProperty("id").GetString()).Should().Equal(
            "builtin.secret-file", "builtin.force-push", "builtin.git-discard", "builtin.wide-delete", "builtin.db-drop", "builtin.pipe-to-shell");
        watch.GetProperty("builtins").EnumerateArray().Should().OnlyContain(b => b.GetProperty("enabled").GetBoolean());
        watch.GetProperty("builtins")[2].GetProperty("notify").GetBoolean().Should().BeFalse();
        watch.GetProperty("builtins")[0].TryGetProperty("command", out _).Should().BeFalse("unset fields are left out");
        watch.GetProperty("user").GetArrayLength().Should().Be(0);
        watch.GetProperty("projects").GetArrayLength().Should().Be(0);
        watch.GetProperty("problems").GetArrayLength().Should().Be(0);

        var settings = (await GetAsync("/v1/settings")).GetProperty("watch");
        settings.GetProperty("enabled").GetBoolean().Should().BeTrue();
        settings.GetProperty("trustedProjects").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task User_rules_round_trip_and_the_test_endpoint_uses_the_real_evaluator()
    {
        using (var put = await PutSettingsAsync(root => root["watch"] = JsonNode.Parse(
            """{"enabled":true,"disabledBuiltins":["builtin.db-drop"],"notifyOffBuiltins":[],"trustedProjects":[],"rules":[{"id":"user.prod","name":"Prod","enabled":true,"notify":true,"tools":["Bash"],"command":"--context\\s+prod"}]}""")))
        {
            put.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var watch = await GetAsync("/v1/watch");
        watch.GetProperty("user").EnumerateArray().Single().GetProperty("id").GetString().Should().Be("user.prod");
        watch.GetProperty("builtins").EnumerateArray().Single(b => b.GetProperty("id").GetString() == "builtin.db-drop").GetProperty("enabled").GetBoolean().Should().BeFalse();

        async Task<string[]> Test(object body)
        {
            using var response = await _http.PostAsJsonAsync("/v1/watch/test", body);
            response.StatusCode.Should().Be(HttpStatusCode.OK);
            var json = await response.Content.ReadFromJsonAsync<JsonElement>();
            return [.. json.GetProperty("matches").EnumerateArray().Select(m => m.GetProperty("id").GetString()!)];
        }

        (await Test(new { tool = "Bash", command = "kubectl apply --context prod && git push --force" })).Should().Equal("builtin.force-push", "user.prod");
        (await Test(new { tool = "Bash", command = "psql -c 'DROP TABLE x'" })).Should().BeEmpty("that built-in is switched off");
        (await Test(new { tool = "Read", path = "/app/.env" })).Should().Equal("builtin.secret-file");
        (await Test(new { })).Should().BeEmpty();

        using var invalid = await PutSettingsAsync(root => root["watch"]!["rules"] = JsonNode.Parse(
            """[{"id":"user.bad","name":"Bad","enabled":true,"notify":true,"command":"(unclosed"}]"""));
        invalid.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await invalid.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("fields").TryGetProperty("watch.rules[0].command", out _).Should().BeTrue();
    }

    [Fact]
    public async Task A_matched_command_reaches_the_api_marks_but_is_never_written_to_a_log_or_the_database()
    {
        var id = "wr-" + Guid.NewGuid().ToString("N");
        var command = $"cat .env {Marker}";
        _host.Pipeline.EnqueueHook(HubFixture.ClaudeEvent(id, "UserPromptSubmit"));
        _host.Pipeline.EnqueueHook(HubFixture.ClaudeEvent(id, "PreToolUse", $$""","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"{{command}}"}"""));
        _host.Pipeline.EnqueueHook(HubFixture.ClaudeEvent(id, "PermissionRequest", $$""","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"{{command}}"}"""));

        var session = await WaitForAsync(async () =>
        {
            var list = await GetAsync("/v1/sessions");
            return list.EnumerateArray().FirstOrDefault(s => s.GetProperty("sessionId").GetString() == id && s.GetProperty("state").GetString() == "WaitingPermission");
        });
        session.GetProperty("pendingPermission").GetProperty("watch").GetProperty("id").GetString().Should().Be("builtin.secret-file");
        session.GetProperty("pendingPermission").GetProperty("command").GetString().Should().Contain(Marker, "the card still shows it, in memory");

        var activity = await GetAsync($"/v1/sessions/claude-code/{id}/activity");
        activity.GetProperty("entries").EnumerateArray().Single(e => e.GetProperty("kind").GetString() == "bash")
            .GetProperty("watch").GetProperty("name").GetString().Should().Be("Secret file");

        // The test endpoint takes the same kind of text; it must not be logged either.
        using (var test = await _http.PostAsJsonAsync("/v1/watch/test", new { tool = "Bash", command }))
        {
            test.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        await Task.Delay(500);
        _log.Snapshot().Should().Contain("Session", "the pipeline did log its state changes").And.NotContain(Marker);

        foreach (var file in Directory.GetFiles(_paths.DataDir, "hub.db*"))
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var copy = new MemoryStream();
            await stream.CopyToAsync(copy);
            Encoding.Latin1.GetString(copy.ToArray()).Should().NotContain(Marker, file);
            Encoding.Latin1.GetString(copy.ToArray()).Should().NotContain("cat .env", file);
        }
    }
}
