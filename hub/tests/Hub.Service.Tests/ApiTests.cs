using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Hub.Contracts;
using Hub.Infrastructure;
using Hub.Service.Api;
using Hub.Service.Hosting;

namespace Hub.Service.Tests;

/// <summary>A real hub (AppHost) on temp folders, shared by the API tests of one class.</summary>
public sealed class HubFixture : IAsyncLifetime
{
    public string Dir { get; } = Path.Combine(Path.GetTempPath(), "agenthub-tests", Guid.NewGuid().ToString("N"));

    public AppHost Host { get; private set; } = null!;

    public HttpClient Http { get; } = new();

    public PortFile Port { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        var paths = new AppPaths(Path.Combine(Dir, "data"), Path.Combine(Dir, "claude"), Path.Combine(Dir, "codex"));
        Host = AppHost.Create(paths);
        await Host.StartAsync(CancellationToken.None);
        Port = PortFile.Parse(await File.ReadAllTextAsync(paths.PortFile))!;
        Http.BaseAddress = new Uri($"http://127.0.0.1:{Port.Port}");
        Http.DefaultRequestHeaders.Add(HubApi.TokenHeader, Port.Token);
    }

    public async Task DisposeAsync()
    {
        Http.Dispose();
        await Host.DisposeAsync();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try
        {
            Directory.Delete(Dir, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    public static byte[] CodexEvent(string sessionId, string name, string extra = "", string? paneId = "pane-9") =>
        Encoding.UTF8.GetBytes(
            $$$"""{"v":1,"agent":"codex","event":"{{{name}}}","receivedAt":"{{{DateTimeOffset.UtcNow:yyyy-MM-ddTHH:mm:ss.fffZ}}}","paneId":{{{(paneId is null ? "null" : "\"" + paneId + "\"")}}},"payload":{"session_id":"{{{sessionId}}}","cwd":"C:\\src\\demo","hook_event_name":"{{{name}}}"{{{extra}}}}}""");
}

public sealed class ApiTests(HubFixture hub) : IClassFixture<HubFixture>
{
    private HttpClient Http => hub.Http;

    // ---- stream ----

    [Fact]
    public async Task Stream_requires_the_token()
    {
        using var anonymous = new HttpClient();
        using var response = await anonymous.GetAsync($"http://127.0.0.1:{hub.Port.Port}/v1/stream");

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Stream_sends_snapshots_then_session_changes()
    {
        using var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader(HubApi.TokenHeader, hub.Port.Token);
        await socket.ConnectAsync(new Uri($"ws://127.0.0.1:{hub.Port.Port}/v1/stream"), CancellationToken.None);

        var types = new List<string>();
        for (var i = 0; i < 5; i++)
        {
            types.Add((await ReceiveAsync(socket)).GetProperty("type").GetString()!);
        }

        types.Should().Equal("sessions", "usage", "limits", "health", "tasks");

        var id = "stream-" + Guid.NewGuid().ToString("N");
        hub.Host.Pipeline.EnqueueHook(HubFixture.CodexEvent(id, "UserPromptSubmit"));

        var found = false;
        for (var i = 0; i < 10 && !found; i++)
        {
            var frame = await ReceiveAsync(socket);
            found = frame.GetProperty("type").GetString() == "sessions"
                && frame.GetProperty("data").EnumerateArray().Any(s => s.GetProperty("sessionId").GetString() == id);
        }

        found.Should().BeTrue("a hook event changes the sessions snapshot");
        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
    }

    [Fact]
    public async Task Stream_resends_task_counts_when_a_task_changes()
    {
        using var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader(HubApi.TokenHeader, hub.Port.Token);
        await socket.ConnectAsync(new Uri($"ws://127.0.0.1:{hub.Port.Port}/v1/stream"), CancellationToken.None);
        for (var i = 0; i < 5; i++)
        {
            await ReceiveAsync(socket);
        }

        var before = WorkEndpoints.TaskCounts(hub.Host, DateTimeOffset.UtcNow);
        var today = DateOnly.FromDateTime(DateTime.Now).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        using var create = await Http.PostAsJsonAsync("/v1/tasks", new { text = "Stream badge " + Guid.NewGuid().ToString("N"), dueDate = today });
        create.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await create.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt64();

        JsonElement? counts = null;
        for (var i = 0; i < 10 && counts is null; i++)
        {
            var frame = await ReceiveAsync(socket);
            if (frame.GetProperty("type").GetString() == "tasks")
            {
                counts = frame.GetProperty("data");
            }
        }

        counts.Should().NotBeNull("adding a task resends the counts");
        (counts!.Value.GetProperty("today").GetInt32() + counts.Value.GetProperty("overdue").GetInt32())
            .Should().Be(before.Today + before.Overdue + 1);
        using var _ = await Http.DeleteAsync($"/v1/tasks/{id}");
        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
    }

    // ---- sessions ----

    [Fact]
    public async Task Sessions_expose_the_pending_permission_and_transitions()
    {
        var id = "perm-" + Guid.NewGuid().ToString("N");
        hub.Host.Pipeline.EnqueueHook(HubFixture.CodexEvent(id, "UserPromptSubmit"));
        hub.Host.Pipeline.EnqueueHook(HubFixture.CodexEvent(id, "PermissionRequest", ""","tool_name":"Bash","tool_input":{"command":"rm -rf build"}"""));

        var session = await WaitForAsync(async () =>
        {
            var list = await GetJsonAsync("/v1/sessions");
            return list.EnumerateArray().FirstOrDefault(s => s.GetProperty("sessionId").GetString() == id && s.GetProperty("state").GetString() == "WaitingPermission");
        });

        session.GetProperty("agent").GetString().Should().Be("codex");
        session.GetProperty("paneId").GetString().Should().Be("pane-9");
        var pending = session.GetProperty("pendingPermission");
        pending.GetProperty("tool").GetString().Should().Be("Bash");
        pending.GetProperty("command").GetString().Should().Be("rm -rf build");
        pending.GetProperty("risk").GetString().Should().Be("deletesFiles");

        // The transition is stored after the live state changes; wait for it instead of reading once.
        var transition = await WaitForAsync(async () =>
        {
            var transitions = await GetJsonAsync($"/v1/sessions/codex/{id}/transitions");
            return transitions.EnumerateArray().FirstOrDefault(t => t.GetProperty("to").GetString() == "WaitingPermission");
        });
        transition.GetProperty("to").GetString().Should().Be("WaitingPermission");

        (await Http.GetAsync("/v1/sessions/codex/nope/transitions")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await Http.GetAsync("/v1/sessions?includeEnded=true")).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Finished_work_stays_unseen_until_marked_seen_and_changes_are_streamed()
    {
        var id = "seen-" + Guid.NewGuid().ToString("N");
        hub.Host.Pipeline.EnqueueHook(HubFixture.CodexEvent(id, "UserPromptSubmit"));
        hub.Host.Pipeline.EnqueueHook(HubFixture.CodexEvent(id, "Stop"));
        var session = await WaitForAsync(async () => (await SessionAsync(id)) is { } s && s.GetProperty("unseen").GetBoolean() ? s : default);
        session.GetProperty("state").GetString().Should().Be("Idle");
        session.GetProperty("lastCompletedAt").ValueKind.Should().Be(JsonValueKind.String);

        using var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader(HubApi.TokenHeader, hub.Port.Token);
        await socket.ConnectAsync(new Uri($"ws://127.0.0.1:{hub.Port.Port}/v1/stream"), CancellationToken.None);
        for (var i = 0; i < 5; i++)
        {
            await ReceiveAsync(socket);
        }

        using (var seen = await Http.PostAsync($"/v1/sessions/codex/{id}/seen", null))
        {
            seen.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }

        var streamed = false;
        for (var i = 0; i < 10 && !streamed; i++)
        {
            var frame = await ReceiveAsync(socket);
            streamed = frame.GetProperty("type").GetString() == "sessions"
                && frame.GetProperty("data").EnumerateArray().Any(s => s.GetProperty("sessionId").GetString() == id && !s.GetProperty("unseen").GetBoolean());
        }

        streamed.Should().BeTrue("marking seen republishes the sessions snapshot");
        (await SessionAsync(id))!.Value.GetProperty("unseen").GetBoolean().Should().BeFalse();

        // Again (nothing left to see) is fine; an unknown session is not.
        (await Http.PostAsync($"/v1/sessions/codex/{id}/seen", null)).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await Http.PostAsync("/v1/sessions/codex/nope/seen", null)).StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Mark all: a second finished session.
        var other = "seen-all-" + Guid.NewGuid().ToString("N");
        hub.Host.Pipeline.EnqueueHook(HubFixture.CodexEvent(other, "UserPromptSubmit"));
        hub.Host.Pipeline.EnqueueHook(HubFixture.CodexEvent(other, "Stop"));
        await WaitForAsync(async () => (await SessionAsync(other)) is { } s && s.GetProperty("unseen").GetBoolean() ? s : default);

        (await Http.PostAsync("/v1/sessions/seen", null)).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await GetJsonAsync("/v1/sessions")).EnumerateArray().Should().NotContain(s => s.GetProperty("unseen").GetBoolean());
        hub.Host.Repository.LoadRecent(DateTimeOffset.UtcNow, TimeSpan.FromMinutes(30))
            .Single(s => s.SessionId == other).SeenAt.Should().NotBeNull("seen is persisted");
        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
    }

    [Fact]
    public void Unseen_reminder_notification_has_titles_in_both_languages()
    {
        var request = new Hub.Core.Notifications.NotificationRequest(
            Hub.Core.Notifications.RuleIds.UnseenReminder, "s1", "alpha", @"C:\src\alpha", Hub.Core.Sessions.SessionState.Idle, null,
            TimeSpan.FromMinutes(31), DateTimeOffset.UtcNow);

        var en = NotificationFeed.From(request, null, "en-US");
        en.RuleId.Should().Be("session.unseen_reminder");
        en.Title.Should().Be("alpha: Finished work waiting for you");
        en.Body.Should().Be("Finished 31m 0s ago");
        en.Severity.Should().Be(NotificationSeverity.Info);
        NotificationFeed.From(request, null, "tr-TR").Title.Should().Be("alpha: Bakmadığın bitmiş iş var");
    }

    // ---- activity ----

    [Fact]
    public async Task Activity_is_served_over_rest_and_streamed_as_deltas()
    {
        using var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader(HubApi.TokenHeader, hub.Port.Token);
        await socket.ConnectAsync(new Uri($"ws://127.0.0.1:{hub.Port.Port}/v1/stream"), CancellationToken.None);
        var snapshot = new List<string>();
        for (var i = 0; i < 5; i++)
        {
            snapshot.Add((await ReceiveAsync(socket)).GetProperty("type").GetString()!);
        }

        snapshot.Should().NotContain("activity", "rings are fetched over REST, never pushed on connect");

        var id = "act-" + Guid.NewGuid().ToString("N");
        hub.Host.Pipeline.EnqueueHook(HubFixture.CodexEvent(id, "UserPromptSubmit"));
        hub.Host.Pipeline.EnqueueHook(HubFixture.CodexEvent(id, "PreToolUse", ""","tool_name":"Bash","tool_use_id":"call_1","tool_input":{"command":"cargo test"}"""));
        hub.Host.Pipeline.EnqueueHook(HubFixture.CodexEvent(id, "PostToolUse", ""","tool_name":"Bash","tool_use_id":"call_1","tool_input":{"command":"cargo test"}"""));
        hub.Host.Pipeline.EnqueueHook(HubFixture.CodexEvent(id, "PreToolUse", ""","tool_name":"apply_patch","tool_use_id":"call_2","tool_input":{"paths":["src/a.rs","C:\\src\\demo\\b.rs"]}"""));

        var frames = new List<JsonElement>();
        for (var i = 0; i < 30 && !frames.SelectMany(f => f.GetProperty("entries").EnumerateArray()).Any(e => e.TryGetProperty("tool", out var t) && t.GetString() == "apply_patch"); i++)
        {
            var frame = await ReceiveAsync(socket);
            if (frame.GetProperty("type").GetString() == "activity" && frame.GetProperty("data").GetProperty("sessionId").GetString() == id)
            {
                frame.GetProperty("data").GetProperty("agent").GetString().Should().Be("codex");
                frames.Add(frame.GetProperty("data"));
            }
        }

        frames.Should().NotBeEmpty();
        var activity = await WaitForAsync(async () =>
        {
            var a = await GetJsonAsync($"/v1/sessions/codex/{id}/activity");
            return a.GetProperty("entries").GetArrayLength() == 3 ? a : default;
        });
        var entries = activity.GetProperty("entries").EnumerateArray().ToList();
        entries[0].GetProperty("kind").GetString().Should().Be("turn");
        entries[0].TryGetProperty("at", out _).Should().BeTrue();
        entries[0].TryGetProperty("status", out _).Should().BeFalse("turn markers carry only id, kind and at");
        entries[1].GetProperty("kind").GetString().Should().Be("bash");
        entries[1].GetProperty("target").GetString().Should().Be("cargo test");
        entries[1].GetProperty("status").GetString().Should().Be("ok");
        entries[1].TryGetProperty("durationMs", out _).Should().BeTrue();
        entries[2].GetProperty("kind").GetString().Should().Be("edit");
        entries[2].GetProperty("status").GetString().Should().Be("running");
        entries[2].GetProperty("paths").EnumerateArray().Select(p => p.GetString()).Should().Equal("src/a.rs", "b.rs");
        activity.GetProperty("plan").ValueKind.Should().Be(JsonValueKind.Null);

        (await Http.GetAsync("/v1/sessions/codex/nope/activity")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
    }

    // ---- usage + limits ----

    [Fact]
    public async Task Usage_routes_answer_and_validate()
    {
        (await GetJsonAsync("/v1/usage/daily?days=3")).GetArrayLength().Should().Be(3);
        (await GetJsonAsync("/v1/usage/blocks")).ValueKind.Should().Be(JsonValueKind.Array);
        (await GetJsonAsync("/v1/usage/breakdown?by=agent")).ValueKind.Should().Be(JsonValueKind.Array);
        (await GetJsonAsync("/v1/usage/current")).GetProperty("today").GetProperty("tokens").GetInt64().Should().Be(0);
        (await GetJsonAsync("/v1/limits")).ValueKind.Should().Be(JsonValueKind.Array);

        var bad = await Http.GetAsync("/v1/usage/daily?days=0");
        bad.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var error = await bad.Content.ReadFromJsonAsync<JsonElement>();
        error.GetProperty("error").GetString().Should().Be("invalidRequest");
        error.GetProperty("fields").TryGetProperty("days", out _).Should().BeTrue();

        (await Http.GetAsync("/v1/usage/breakdown?by=planet")).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ---- reports ----

    [Fact]
    public async Task Reports_answer_in_json_csv_and_xlsx()
    {
        (await GetJsonAsync("/v1/reports/waits")).GetProperty("count").GetInt32().Should().BeGreaterThanOrEqualTo(0);
        (await GetJsonAsync("/v1/reports/cost?groupBy=agent")).GetProperty("groupBy").GetString().Should().Be("agent");

        using var csv = await Http.GetAsync("/v1/reports/cost?format=csv&lang=en");
        csv.Content.Headers.ContentType!.MediaType.Should().Be("text/csv");
        (await csv.Content.ReadAsStringAsync()).Should().Contain("Projects");

        using var xlsx = await Http.GetAsync("/v1/reports/cost?format=xlsx");
        xlsx.StatusCode.Should().Be(HttpStatusCode.OK);
        (await xlsx.Content.ReadAsByteArrayAsync())[..2].Should().Equal((byte)'P', (byte)'K');

        (await Http.GetAsync("/v1/reports/cost?groupBy=galaxy")).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await Http.GetAsync("/v1/reports/waits?from=2026-10-05&to=2026-10-01")).StatusCode.Should().Be(HttpStatusCode.BadRequest);

        (await GetJsonAsync("/v1/reports/daily-summaries")).ValueKind.Should().Be(JsonValueKind.Array);
        (await GetJsonAsync("/v1/reports/daily-summaries/status")).GetProperty("generationAvailable").GetBoolean().Should().BeFalse();
        (await GetJsonAsync("/v1/reports/daily-summaries/2026-10-01")).GetProperty("summary").ValueKind.Should().Be(JsonValueKind.Null);
        (await Http.GetAsync("/v1/reports/daily-summaries/2026-13-01")).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Customers_crud()
    {
        var created = await (await Http.PostAsJsonAsync("/v1/customers", new { name = "ACME", color = "#ff0000" })).Content.ReadFromJsonAsync<JsonElement>();
        var id = created.GetProperty("id").GetInt64();

        using var put = await Http.PutAsJsonAsync($"/v1/customers/{id}", new { name = "ACME Ltd" });
        (await put.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("name").GetString().Should().Be("ACME Ltd");

        (await Http.DeleteAsync($"/v1/customers/{id}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await Http.DeleteAsync($"/v1/customers/{id}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await Http.PostAsJsonAsync("/v1/customers", new { name = " " })).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ---- projects ----

    [Fact]
    public async Task Projects_routes_answer_and_validate()
    {
        (await GetJsonAsync("/v1/projects")).ValueKind.Should().Be(JsonValueKind.Array);
        (await Http.GetAsync("/v1/projects/files")).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await Http.GetAsync("/v1/projects/files?root=C:%5Cnowhere")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await Http.PostAsJsonAsync("/v1/projects/folders", new { path = Path.Combine(hub.Dir, "missing") })).StatusCode.Should().Be(HttpStatusCode.BadRequest);

        var folder = Path.Combine(hub.Dir, "proj");
        Directory.CreateDirectory(folder);
        (await Http.PostAsJsonAsync("/v1/projects/folders", new { path = folder })).StatusCode.Should().Be(HttpStatusCode.Created);
    }

    // ---- tasks ----

    [Fact]
    public async Task Tasks_crud_and_validation()
    {
        using var create = await Http.PostAsJsonAsync("/v1/tasks", new { text = "Call the bank\nabout the card", dueDate = "2026-10-10", dueTime = "14:30", priority = "high" });
        create.StatusCode.Should().Be(HttpStatusCode.Created);
        var task = await create.Content.ReadFromJsonAsync<JsonElement>();
        var id = task.GetProperty("id").GetInt64();
        task.GetProperty("title").GetString().Should().Be("Call the bank");
        task.GetProperty("details").GetString().Should().Be("about the card");
        task.GetProperty("priority").GetString().Should().Be("high");
        task.GetProperty("dueTime").GetString().Should().Be("14:30");

        (await GetJsonAsync("/v1/tasks?q=bank")).EnumerateArray().Should().Contain(t => t.GetProperty("id").GetInt64() == id);

        using var update = await Http.PutAsJsonAsync($"/v1/tasks/{id}", new { text = "Call the bank today", priority = "low" });
        (await update.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("dueDate").ValueKind.Should().Be(JsonValueKind.Null);

        using var done = await Http.PostAsJsonAsync($"/v1/tasks/{id}/complete", new { completed = true });
        (await done.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("completedAt").ValueKind.Should().Be(JsonValueKind.String);
        (await GetJsonAsync("/v1/tasks?filter=done")).EnumerateArray().Should().Contain(t => t.GetProperty("id").GetInt64() == id);

        (await Http.DeleteAsync($"/v1/tasks/{id}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await Http.DeleteAsync($"/v1/tasks/{id}")).StatusCode.Should().Be(HttpStatusCode.NotFound);

        var invalid = await Http.PostAsJsonAsync("/v1/tasks", new { text = "", dueTime = "10:00" });
        invalid.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var fields = (await invalid.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("fields");
        fields.TryGetProperty("text", out _).Should().BeTrue();
        fields.TryGetProperty("dueTime", out _).Should().BeTrue();
        (await Http.GetAsync("/v1/tasks?filter=someday")).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ---- dictation ----

    [Fact]
    public async Task Dictation_routes_answer_without_downloading()
    {
        (await GetJsonAsync("/v1/dictations")).GetArrayLength().Should().Be(0);
        (await Http.DeleteAsync("/v1/dictations/42")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await Http.DeleteAsync("/v1/dictations")).StatusCode.Should().Be(HttpStatusCode.NoContent);

        var models = await GetJsonAsync("/v1/dictation/models");
        models.EnumerateArray().Select(m => m.GetProperty("id").GetString()).Should().Equal("large", "small");
        models.EnumerateArray().Should().OnlyContain(m => !m.GetProperty("installed").GetBoolean() && !m.GetProperty("downloading").GetBoolean());

        (await Http.PostAsync("/v1/dictation/models/huge/download", null)).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await Http.PostAsync("/v1/dictation/models/small/cancel", null)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    private static readonly string[] FileOutput = ["file"];
    private static readonly string[] TypeOutput = ["type"];

    private static ByteArrayContent Pcm(byte[] bytes, string contentType = "application/octet-stream")
    {
        var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(contentType);
        return content;
    }

    private static byte[] SpeechPcm(double seconds)
    {
        var samples = Enumerable.Range(0, (int)(seconds * 16_000)).Select(i => 0.1f * MathF.Sin(i * 0.2f)).ToArray();
        var bytes = new byte[samples.Length * sizeof(float)];
        Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);
        return bytes;
    }

    [Fact]
    public async Task Dictation_transcribe_checks_the_body_and_answers_no_speech_or_model_missing()
    {
        using (var wrongType = await Http.PostAsync("/v1/dictation/transcribe", Pcm(new byte[8], "application/json")))
        {
            wrongType.StatusCode.Should().Be(HttpStatusCode.UnsupportedMediaType);
        }

        using (var odd = await Http.PostAsync("/v1/dictation/transcribe", Pcm(new byte[7])))
        {
            odd.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }

        using (var silence = await Http.PostAsync("/v1/dictation/transcribe", Pcm(new byte[16_000 * 4])))
        {
            silence.StatusCode.Should().Be(HttpStatusCode.OK);
            var body = await silence.Content.ReadFromJsonAsync<JsonElement>();
            body.GetProperty("status").GetString().Should().Be("noSpeech");
            body.GetProperty("model").GetString().Should().Be("large");
        }

        using (var speech = await Http.PostAsync("/v1/dictation/transcribe", Pcm(SpeechPcm(1))))
        {
            speech.StatusCode.Should().Be(HttpStatusCode.Conflict);
            (await speech.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString().Should().Be("modelMissing");
        }

        using (var preload = await Http.PostAsync("/v1/dictation/preload", null))
        {
            preload.StatusCode.Should().Be(HttpStatusCode.Conflict);
        }

        using (var cancel = await Http.PostAsync("/v1/dictation/cancel", null))
        {
            cancel.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }
    }

    [Fact]
    public async Task Dictation_transcribe_rejects_a_body_longer_than_max_minutes()
    {
        var limit = hub.Host.Dictation.MaxBodyBytes;
        // The hub answers 413 from Content-Length without reading the body and then drops the connection. With
        // Expect: 100-continue the body is never sent, and a client of its own keeps the shared pool clean.
        using var client = new HttpClient { BaseAddress = Http.BaseAddress };
        client.DefaultRequestHeaders.Add(HubApi.TokenHeader, hub.Port.Token);
        client.DefaultRequestHeaders.ExpectContinue = true;
        using var tooLarge = await client.PostAsync("/v1/dictation/transcribe", Pcm(new byte[limit + 4]));

        tooLarge.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);
    }

    [Fact]
    public async Task Dictation_cleanup_returns_the_text_when_ai_cleanup_is_off()
    {
        using var response = await Http.PostAsJsonAsync("/v1/dictation/cleanup", new { text = "ham metin" });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("finalText").GetString().Should().Be("ham metin");
        body.GetProperty("cleaned").GetBoolean().Should().BeFalse();
        (await Http.PostAsJsonAsync("/v1/dictation/cleanup", new { })).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Dictation_save_writes_the_file_output_and_the_history()
    {
        var before = hub.Host.Settings;
        var file = Path.Combine(hub.Dir, "dictation-out", "notes.md");
        hub.Host.UpdateSettings(before with { Dictation = before.Dictation with { OutputFile = true, FilePath = file } });
        try
        {
            using var invalid = await Http.PostAsJsonAsync("/v1/dictations", new { durationSeconds = -1, finalText = "", outputs = FileOutput });
            invalid.StatusCode.Should().Be(HttpStatusCode.BadRequest);
            var fields = (await invalid.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("fields");
            fields.EnumerateObject().Select(f => f.Name).Should().BeEquivalentTo("durationSeconds", "rawText", "finalText", "outputs");

            using var saved = await Http.PostAsJsonAsync(
                "/v1/dictations", new { durationSeconds = 4.2, rawText = "ham", finalText = "Kaydedilen not.", cleaned = false, outputs = TypeOutput });
            saved.StatusCode.Should().Be(HttpStatusCode.OK);
            var body = await saved.Content.ReadFromJsonAsync<JsonElement>();
            body.GetProperty("outputs").EnumerateArray().Select(o => o.GetString()).Should().Equal("type", "file");
            body.GetProperty("fileError").ValueKind.Should().Be(JsonValueKind.Null);
            var id = body.GetProperty("id").GetInt64();

            (await File.ReadAllTextAsync(file)).Should().Contain("Kaydedilen not.").And.StartWith("## ");
            var history = await GetJsonAsync("/v1/dictations?limit=1");
            history[0].GetProperty("id").GetInt64().Should().Be(id);
            history[0].GetProperty("outputs").GetString().Should().Be("type,file");
            (await Http.DeleteAsync($"/v1/dictations/{id}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        }
        finally
        {
            hub.Host.UpdateSettings(before);
        }
    }

    // ---- settings ----

    [Fact]
    public async Task Settings_round_trip_and_validation()
    {
        var current = await GetJsonAsync("/v1/settings");
        current.TryGetProperty("statusLineWrappedCommand", out _).Should().BeFalse("bookkeeping is not part of the API");

        using var same = await Http.PutAsync("/v1/settings", new StringContent(current.GetRawText(), Encoding.UTF8, "application/json"));
        same.StatusCode.Should().Be(HttpStatusCode.OK);

        var invalid = current.GetRawText().Replace("\"contextThresholdPercent\":80", "\"contextThresholdPercent\":150", StringComparison.Ordinal);
        invalid.Should().NotBe(current.GetRawText());
        using var bad = await Http.PutAsync("/v1/settings", new StringContent(invalid, Encoding.UTF8, "application/json"));
        bad.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await bad.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("fields").TryGetProperty("rules.contextThresholdPercent", out _).Should().BeTrue();

        // Unseen reminder: off by default, 30 minutes, 1 minute..1 day.
        var rules = current.GetProperty("rules");
        rules.GetProperty("unseenReminderEnabled").GetBoolean().Should().BeFalse();
        rules.GetProperty("unseenReminderAfter").GetString().Should().Be("00:30:00");
        foreach (var (value, ok) in new[] { ("00:00:30", false), ("00:01:00", true), ("1.00:00:00", true), ("1.00:01:00", false) })
        {
            var text = current.GetRawText().Replace("\"unseenReminderAfter\":\"00:30:00\"", $"\"unseenReminderAfter\":\"{value}\"", StringComparison.Ordinal)
                .Replace("\"unseenReminderEnabled\":false", "\"unseenReminderEnabled\":true", StringComparison.Ordinal);
            using var put = await Http.PutAsync("/v1/settings", new StringContent(text, Encoding.UTF8, "application/json"));
            put.StatusCode.Should().Be(ok ? HttpStatusCode.OK : HttpStatusCode.BadRequest, value);
            if (ok)
            {
                hub.Host.Settings.Rules.UnseenReminderEnabled.Should().BeTrue();
                hub.Host.Settings.Rules.UnseenReminderAfter.Should().Be(TimeSpan.Parse(value, CultureInfo.InvariantCulture));
            }
            else
            {
                (await put.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("fields").TryGetProperty("rules.unseenReminderAfter", out _).Should().BeTrue();
            }
        }

        using (var restore = await Http.PutAsync("/v1/settings", new StringContent(current.GetRawText(), Encoding.UTF8, "application/json")))
        {
            restore.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        (await Http.PutAsync("/v1/settings", new StringContent("{", Encoding.UTF8, "application/json"))).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await GetJsonAsync("/v1/pricing")).TryGetProperty("models", out _).Should().BeTrue();
    }

    private async Task<JsonElement> GetJsonAsync(string path)
    {
        using var response = await Http.GetAsync(path);
        response.StatusCode.Should().Be(HttpStatusCode.OK, path);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private async Task<JsonElement?> SessionAsync(string id) =>
        (await GetJsonAsync("/v1/sessions")).EnumerateArray().Cast<JsonElement?>().FirstOrDefault(s => s!.Value.GetProperty("sessionId").GetString() == id);

    private static async Task<JsonElement> WaitForAsync(Func<Task<JsonElement>> probe)
    {
        for (var i = 0; i < 50; i++)
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

    private static async Task<JsonElement> ReceiveAsync(ClientWebSocket socket)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(chunk, timeout.Token);
            buffer.Write(chunk, 0, result.Count);
        }
        while (!result.EndOfMessage);

        return JsonDocument.Parse(buffer.ToArray()).RootElement.Clone();
    }
}
