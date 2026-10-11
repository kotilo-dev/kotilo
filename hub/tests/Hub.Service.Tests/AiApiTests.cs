using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Hub.Core.Ai;
using Hub.Service.Hosting;

namespace Hub.Service.Tests;

/// <summary>A minimal OpenAI-compatible server on loopback (one canned answer per request; no URL ACL needed).</summary>
public sealed class FakeOpenAiServer : IAsyncDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource _stop = new();
    private readonly Task _loop;

    public FakeOpenAiServer()
    {
        _listener.Start();
        _loop = Task.Run(LoopAsync);
    }

    public string BaseUrl => $"http://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}";

    public List<(string RequestLine, string? Authorization, string Body)> Requests { get; } = [];

    public int Status { get; set; } = 200;

    public string Answer { get; set; } = """{"model":"fake-model","choices":[{"message":{"role":"assistant","content":"OK"}}]}""";

    /// <summary>Set: answer as server-sent events, one write (and flush) per item, <see cref="ChunkDelay"/> apart.</summary>
    public IReadOnlyList<string>? Events { get; set; }

    public TimeSpan ChunkDelay { get; set; } = TimeSpan.FromMilliseconds(30);

    /// <summary>After the events, keep the connection open until the client closes it (then <see cref="ClientClosed"/> completes).</summary>
    public bool HoldOpen { get; set; }

    public TaskCompletionSource ClientClosed { get; private set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>One SSE chunk with <c>choices[0].delta.content</c>.</summary>
    public static string Delta(string text) =>
        "data: " + JsonSerializer.Serialize(new { model = "fake-model", choices = new[] { new { delta = new { content = text } } } }) + "\n\n";

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        _listener.Stop();
        await _loop.ContinueWith(_ => { }, TaskScheduler.Default);
        _stop.Dispose();
    }

    private async Task LoopAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            try
            {
                var client = await _listener.AcceptTcpClientAsync(_stop.Token);
                _ = Task.Run(() => HandleAsync(client));
            }
            catch (Exception ex) when (ex is OperationCanceledException or SocketException or ObjectDisposedException)
            {
            }
        }
    }

    private async Task HandleAsync(TcpClient connection)
    {
        using var client = connection;
        try
        {
            await using var stream = client.GetStream();
            var head = new StringBuilder();
            var buffer = new byte[1];
            while (!head.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal) && await stream.ReadAsync(buffer, _stop.Token) == 1)
            {
                head.Append((char)buffer[0]);
            }

            var lines = head.ToString().Split("\r\n");
            string? Header(string name) => lines.FirstOrDefault(l => l.StartsWith(name + ":", StringComparison.OrdinalIgnoreCase))?[(name.Length + 1)..].Trim();
            var length = int.TryParse(Header("Content-Length"), out var n) ? n : 0;
            var body = new byte[length];
            await stream.ReadExactlyAsync(body, _stop.Token);
            lock (Requests)
            {
                Requests.Add((lines[0], Header("Authorization"), Encoding.UTF8.GetString(body)));
            }

            if (Events is { } events)
            {
                await stream.WriteAsync("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"u8.ToArray(), _stop.Token);
                foreach (var e in events)
                {
                    await stream.WriteAsync(Encoding.UTF8.GetBytes(e), _stop.Token);
                    await stream.FlushAsync(_stop.Token);
                    await Task.Delay(ChunkDelay, _stop.Token);
                }

                if (HoldOpen)
                {
                    while (await stream.ReadAsync(buffer, _stop.Token) > 0)
                    {
                    }
                }

                return;
            }

            var payload = Encoding.UTF8.GetBytes(Answer);
            var response = $"HTTP/1.1 {Status} X\r\nContent-Type: application/json\r\nContent-Length: {payload.Length}\r\nConnection: close\r\n\r\n";
            await stream.WriteAsync(Encoding.ASCII.GetBytes(response), _stop.Token);
            await stream.WriteAsync(payload, _stop.Token);
        }
        catch (Exception ex) when (ex is OperationCanceledException or IOException or SocketException or ObjectDisposedException)
        {
        }
        finally
        {
            if (HoldOpen)
            {
                ClientClosed.TrySetResult();
            }
        }
    }
}

public sealed class AiApiTests(HubFixture hub) : IClassFixture<HubFixture>, IAsyncLifetime
{
    private readonly FakeOpenAiServer _server = new();

    private HttpClient Http => hub.Http;

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync() => await _server.DisposeAsync();

    private async Task<JsonObject> SettingsAsync() => (await Http.GetFromJsonAsync<JsonObject>("/v1/settings"))!;

    private Task<HttpResponseMessage> PutSettingsAsync(JsonObject settings) =>
        Http.PutAsync("/v1/settings", new StringContent(settings.ToJsonString(), Encoding.UTF8, "application/json"));

    private static JsonObject Ai(string providers, string assistant, string dailySummary, string dictationCleanup) => JsonNode.Parse(
        $$"""{"providers":{{providers}},"assistant":{{assistant}},"dailySummary":{{dailySummary}},"dictationCleanup":{{dictationCleanup}}}""")!.AsObject();

    [Fact]
    public async Task Providers_keys_test_and_fully_local_work_end_to_end()
    {
        var settings = await SettingsAsync();
        settings["ai"]!["dailySummary"]!["provider"]!.GetValue<string>().Should().Be("cli:claude-code");
        settings["dictation"]!.AsObject().ContainsKey("aiModel").Should().BeFalse("the legacy aliases are gone from the API");
        settings["insights"]!.AsObject().ContainsKey("dailySummaryModel").Should().BeFalse();

        var local = $$"""{"provider":"openai:local"}""";
        settings["ai"] = Ai($$"""[{"name":"local","kind":"openai","baseUrl":"{{_server.BaseUrl}}","model":"m-default"}]""", local, local, local);
        using (var put = await PutSettingsAsync(settings))
        {
            put.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        // Key: stored in the (in-memory) vault, only `hasKey` comes back.
        (await Http.PutAsJsonAsync("/v1/ai/providers/local/key", new { key = "sk-secret" })).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await Http.PutAsJsonAsync("/v1/ai/providers/missing/key", new { key = "x" })).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await Http.PutAsJsonAsync("/v1/ai/providers/local/key", new { key = "a\nb" })).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var raw = await Http.GetStringAsync("/v1/settings");
        raw.Should().NotContain("sk-secret");
        (await SettingsAsync())["ai"]!["providers"]![0]!["hasKey"]!.GetValue<bool>().Should().BeTrue();
        File.ReadAllText(hub.Host.Paths.SettingsPath).Should().NotContain("sk-secret");

        var providers = await Http.GetFromJsonAsync<JsonObject>("/v1/ai/providers");
        var entry = providers!["providers"]!.AsArray().Single(p => p!["id"]!.GetValue<string>() == "openai:local")!;
        (entry["kind"]!.GetValue<string>(), entry["isLoopback"]!.GetValue<bool>(), entry["hasKey"]!.GetValue<bool>()).Should().Be(("openai", true, true));
        providers["fullyLocal"]!.GetValue<bool>().Should().BeTrue();
        providers["providers"]!.AsArray().Where(p => p!["kind"]!.GetValue<string>() == "cli")
            .Select(p => p!["installed"]!.GetValue<bool>())
            .Should().NotContain(false, "only agents found on this machine are listed (none on a CI runner)");

        // Test: a fixed tiny prompt, the key as a bearer token, no content echoed back.
        using var test = await Http.PostAsJsonAsync("/v1/ai/test", new { provider = "openai:local", model = "m-test" });
        test.StatusCode.Should().Be(HttpStatusCode.OK);
        var result = (await test.Content.ReadFromJsonAsync<JsonObject>())!;
        result.Select(p => p.Key).Should().BeEquivalentTo("ok", "errorKind", "latencyMs");
        (result["ok"]!.GetValue<bool>(), result["errorKind"]!.GetValue<string>()).Should().Be((true, "none"));
        var (line, auth, body) = _server.Requests.Last();
        line.Should().StartWith("POST /v1/chat/completions");
        auth.Should().Be("Bearer sk-secret");
        body.Should().Contain("\"model\":\"m-test\"").And.Contain("Reply with OK");

        _server.Status = 401;
        _server.Answer = """{"error":{"message":"nope"}}""";
        var denied = await (await Http.PostAsJsonAsync("/v1/ai/test", new { provider = "openai:local" })).Content.ReadFromJsonAsync<JsonObject>();
        (denied!["ok"]!.GetValue<bool>(), denied["errorKind"]!.GetValue<string>()).Should().Be((false, "unauthorized"));
        var unknown = await (await Http.PostAsJsonAsync("/v1/ai/test", new { provider = "openai:nobody" })).Content.ReadFromJsonAsync<JsonObject>();
        unknown!["errorKind"]!.GetValue<string>().Should().Be("notConfigured");
        (await Http.PostAsJsonAsync("/v1/ai/test", new { provider = "claude" })).StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // Features run on the provider too (daily summary path).
        _server.Status = 200;
        _server.Answer = """{"choices":[{"message":{"content":"Summary."}}]}""";
        var generated = await hub.Host.Buddy.GenerateAsync(AiFeature.DailySummary, "{}", "sys", TimeSpan.FromSeconds(10), CancellationToken.None);
        generated.Should().Be(AiResult.Ok("Summary.", "m-default"));

        // Removing the provider removes its key.
        settings = await SettingsAsync();
        var cli = """{"provider":"cli:claude-code","model":"haiku"}""";
        settings["ai"] = Ai("[]", cli, cli, cli);
        (await PutSettingsAsync(settings)).StatusCode.Should().Be(HttpStatusCode.OK);
        hub.Host.AiProviders.Secrets.Read("local").Should().BeNull();
        (await Http.DeleteAsync("/v1/ai/providers/local/key")).StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task Invalid_ai_settings_are_reported_per_field()
    {
        var settings = await SettingsAsync();
        settings["ai"] = Ai(
            """[{"name":"a b","kind":"other","baseUrl":"ftp://x","model":"bad model"},{"name":"ok","kind":"openai","baseUrl":"http://localhost:1"}]""",
            """{"provider":"cli:nope"}""",
            """{"provider":"openai:ok"}""",
            """{"provider":"claude","model":"%PATH%"}""");

        using var put = await PutSettingsAsync(settings);

        put.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var fields = (await put.Content.ReadFromJsonAsync<JsonObject>())!["fields"]!.AsObject().Select(f => f.Key);
        fields.Should().BeEquivalentTo(
            "ai.providers[0].name", "ai.providers[0].kind", "ai.providers[0].baseUrl", "ai.providers[0].model",
            "ai.assistant.provider", "ai.dailySummary.model", "ai.dictationCleanup.provider", "ai.dictationCleanup.model");

        // A pre-M3 client that leaves `ai` out keeps the stored choice.
        var before = (await SettingsAsync())["ai"]!.ToJsonString();
        settings.Remove("ai");
        (await PutSettingsAsync(settings)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await SettingsAsync())["ai"]!.ToJsonString().Should().Be(before);
    }

    [Fact]
    public async Task Mascot_settings_round_trip_and_scale_is_validated()
    {
        var settings = await SettingsAsync();
        var buddy = settings["buddy"]!.AsObject();
        (buddy["mascotEnabled"]!.GetValue<bool>(), buddy["mascotOffered"]!.GetValue<bool>()).Should().Be((false, false));

        buddy["mascotOffered"] = true;
        buddy["mascotScale"] = 1;
        using (var bad = await PutSettingsAsync(settings))
        {
            bad.StatusCode.Should().Be(HttpStatusCode.BadRequest);
            (await bad.Content.ReadFromJsonAsync<JsonObject>())!["fields"]!.AsObject().Select(f => f.Key).Should().Equal("buddy.mascotScale");
        }

        buddy["mascotScale"] = 2;
        (await PutSettingsAsync(settings)).StatusCode.Should().Be(HttpStatusCode.OK);
        var saved = (await SettingsAsync())["buddy"]!;
        (saved["mascotOffered"]!.GetValue<bool>(), saved["mascotScale"]!.GetValue<int>()).Should().Be((true, 2));
        hub.Host.Settings.Buddy.MascotOffered.Should().BeTrue();
    }
}

public sealed class AppSettingsMigrationTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "agenthub-tests", Guid.NewGuid().ToString("N"));

    public AppSettingsMigrationTests() => Directory.CreateDirectory(_dir);

    public void Dispose()
    {
        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    [Fact]
    public void Pre_m3_model_aliases_move_to_claude_code_providers_and_toggles_stay()
    {
        var path = Path.Combine(_dir, "settings.json");
        File.WriteAllText(path, """
            {
              "Buddy": { "Model": "sonnet", "Enabled": true },
              "Insights": { "DailySummaryModel": "opus", "DailySummaryWithoutAi": true },
              "Dictation": { "AiModel": "haiku", "AiCleanup": true }
            }
            """);

        var settings = AppSettings.Load(path);

        settings.Ai.Assistant.Should().Be(new AiFeatureChoice { Provider = "cli:claude-code", Model = "sonnet" });
        settings.Ai.DailySummary.Should().Be(new AiFeatureChoice { Provider = "cli:claude-code", Model = "opus" });
        settings.Ai.DictationCleanup.Should().Be(new AiFeatureChoice { Provider = "cli:claude-code", Model = "haiku" });
        settings.Insights.DailySummaryWithoutAi.Should().BeTrue();
        settings.Dictation.AiCleanup.Should().BeTrue();
        (settings.Buddy.Model, settings.Insights.DailySummaryModel, settings.Dictation.AiModel).Should().Be((null, null, null));

        settings.Save(path);
        var saved = File.ReadAllText(path);
        saved.Should().NotContain("\"AiModel\"").And.NotContain("\"DailySummaryModel\"").And.Contain("\"Ai\"");
        AppSettings.Load(path).Ai.Should().BeEquivalentTo(settings.Ai);
    }

    [Fact]
    public void Unversioned_files_turn_the_mascot_off_once_and_keep_the_users_later_choice()
    {
        var path = Path.Combine(_dir, "settings.json");
        File.WriteAllText(path, """
            {
              "Language": "en-US",
              "Buddy": { "Enabled": true, "MascotEnabled": true, "MascotScale": 4, "WalkArea": "corner" }
            }
            """);

        var migrated = AppSettings.Load(path);
        migrated.Version.Should().Be(AppSettings.CurrentVersion);
        migrated.Buddy.MascotEnabled.Should().BeFalse();
        migrated.Buddy.MascotOffered.Should().BeFalse();
        (migrated.Buddy.MascotScale, migrated.Buddy.WalkArea, migrated.Language).Should().Be((4, "corner", "en-US"));

        // The user turns it on later: a versioned file keeps that choice.
        (migrated with { Buddy = migrated.Buddy with { MascotEnabled = true, MascotOffered = true } }).Save(path);
        File.ReadAllText(path).Should().Contain("\"Version\": 1");
        var reloaded = AppSettings.Load(path);
        (reloaded.Buddy.MascotEnabled, reloaded.Buddy.MascotOffered).Should().Be((true, true));
    }

    [Fact]
    public void New_installs_have_the_mascot_off_and_not_offered()
    {
        var path = Path.Combine(_dir, "settings.json");
        var fresh = AppSettings.Load(path);
        (fresh.Version, fresh.Buddy.MascotEnabled, fresh.Buddy.MascotOffered).Should().Be((AppSettings.CurrentVersion, false, false));

        // A default file saved by a new install is versioned, so the migration never runs on it.
        (fresh with { Buddy = fresh.Buddy with { MascotEnabled = true } }).Save(path);
        AppSettings.Load(path).Buddy.MascotEnabled.Should().BeTrue();
    }

    [Fact]
    public void New_installs_default_to_claude_code_haiku_and_keep_ai_settings()
    {
        var path = Path.Combine(_dir, "settings.json");
        AppSettings.Load(path).Ai.Should().BeEquivalentTo(new AiSettings());

        var custom = new AppSettings
        {
            Ai = new AiSettings
            {
                Providers = [new AiProviderConfig { Name = "ollama", BaseUrl = "http://localhost:11434", Model = "llama3" }],
                DictationCleanup = new AiFeatureChoice { Provider = "openai:ollama" },
            },
        };
        custom.Save(path);

        var loaded = AppSettings.Load(path);
        loaded.Ai.Should().BeEquivalentTo(custom.Ai);
        loaded.Ai.Provider("OLLAMA")!.BaseUrl.Should().Be("http://localhost:11434");
    }
}
