using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Hub.Core.Ai;
using Serilog;
using Serilog.Core;
using Serilog.Events;

namespace Hub.Service.Tests;

/// <summary><c>/v1/assistant/*</c> against a fake OpenAI-compatible server that streams server-sent events.</summary>
public sealed class AssistantApiTests(HubFixture hub) : IClassFixture<HubFixture>, IAsyncLifetime
{
    /// <summary>Words that only appear in the conversation: the log must never contain them.</summary>
    private const string SecretQuestion = "zebra-quartz-7731";
    private const string SecretAnswer = "quokka-ember-4402";

    private readonly FakeOpenAiServer _server = new();

    private HttpClient Http => hub.Http;

    public async Task InitializeAsync()
    {
        var settings = await SettingsAsync();
        var local = """{"provider":"openai:local"}""";
        settings["ai"] = JsonNode.Parse(
            $$"""{"providers":[{"name":"local","kind":"openai","baseUrl":"{{_server.BaseUrl}}","model":"m-default"}],"assistant":{{local}},"dailySummary":{{local}},"dictationCleanup":{{local}}}""");
        using var put = await PutSettingsAsync(settings);
        put.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    public async Task DisposeAsync() => await _server.DisposeAsync();

    private async Task<JsonObject> SettingsAsync() => (await Http.GetFromJsonAsync<JsonObject>("/v1/settings"))!;

    private Task<HttpResponseMessage> PutSettingsAsync(JsonNode settings) =>
        Http.PutAsync("/v1/settings", new StringContent(settings.ToJsonString(), Encoding.UTF8, "application/json"));

    private static HttpRequestMessage ChatRequest(object body) => new(HttpMethod.Post, "/v1/assistant/chat") { Content = JsonContent.Create(body) };

    private static object Ask(string text) => new { messages = new[] { new { role = "user", text } } };

    private async Task<List<JsonObject>> ChatAsync(object body)
    {
        using var response = await Http.SendAsync(ChatRequest(body), HttpCompletionOption.ResponseHeadersRead);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Content.Headers.ContentType!.MediaType.Should().Be("application/x-ndjson");
        var text = await response.Content.ReadAsStringAsync();
        return text.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => JsonNode.Parse(l)!.AsObject()).ToList();
    }

    [Fact]
    public async Task Info_describes_the_assistant_provider()
    {
        var info = (await Http.GetFromJsonAsync<JsonObject>("/v1/assistant/info"))!;

        info.ToJsonString().Should().Be(
            """{"enabled":true,"provider":"openai:local","providerLabel":"local","model":"m-default","ephemeral":true,"available":true,"unavailableReason":null}""");
    }

    [Fact]
    public async Task A_chat_streams_meta_then_growing_text_then_done_and_logs_no_text()
    {
        _server.Events = [FakeOpenAiServer.Delta("The answer "), FakeOpenAiServer.Delta("is "), FakeOpenAiServer.Delta(SecretAnswer), "data: [DONE]\n\n"];
        _server.ChunkDelay = TimeSpan.FromMilliseconds(120);
        var sink = new CapturingSink();
        var previous = Log.Logger;
        Log.Logger = new LoggerConfiguration().MinimumLevel.Verbose().WriteTo.Sink(sink).CreateLogger();
        List<JsonObject> frames;
        try
        {
            frames = await ChatAsync(new
            {
                messages = new[]
                {
                    new { role = "user", text = "first " + SecretQuestion },
                    new { role = "assistant", text = "earlier answer" },
                    new { role = "user", text = "and now?" },
                },
            });
        }
        finally
        {
            Log.Logger = previous;
        }

        frames[0].ToJsonString().Should().Be("""{"type":"meta","provider":"openai:local","providerLabel":"local","model":"m-default","ephemeral":true}""");
        frames[^1].ToJsonString().Should().Be("""{"type":"done","errorKind":"none","error":null}""");
        var texts = frames.Skip(1).SkipLast(1).Select(f => (f["type"]!.GetValue<string>(), f["text"]!.GetValue<string>())).ToList();
        texts.Should().HaveCountGreaterThan(1, "the answer is streamed, not sent once");
        texts.Select(t => t.Item1).Should().AllBe("text");
        texts[^1].Item2.Should().Be("The answer is " + SecretAnswer);
        texts.Select(t => t.Item2.Length).Should().BeInAscendingOrder("each text frame carries the full text so far");

        var request = _server.Requests.Last().Body;
        request.Should().Contain("\"stream\":true").And.Contain(SecretQuestion).And.Contain("\"role\":\"assistant\"");

        var log = sink.Text;
        log.Should().Contain("AI run").And.Contain("openai:local").And.Contain("3 messages");
        log.Should().NotContain(SecretQuestion).And.NotContain(SecretAnswer).And.NotContain("earlier answer");
    }

    [Fact]
    public async Task One_chat_at_a_time_and_an_abort_cancels_the_run()
    {
        _server.Events = [FakeOpenAiServer.Delta("Thinking about it")];
        _server.ChunkDelay = TimeSpan.Zero;
        _server.HoldOpen = true;
        var runs = new ConcurrentQueue<AiRunInfo>();
        void OnRun(AiRunInfo r) => runs.Enqueue(r);
        hub.Host.Ai.Completed += OnRun;
        try
        {
            using var abort = new CancellationTokenSource();
            using var first = await Http.SendAsync(ChatRequest(Ask("long one")), HttpCompletionOption.ResponseHeadersRead, abort.Token);
            first.StatusCode.Should().Be(HttpStatusCode.OK);
            using var reader = new StreamReader(await first.Content.ReadAsStreamAsync(abort.Token));
            (await reader.ReadLineAsync(abort.Token)).Should().Contain("\"type\":\"meta\"");
            (await reader.ReadLineAsync(abort.Token)).Should().Be("""{"type":"text","text":"Thinking about it"}""");

            using (var second = await Http.SendAsync(ChatRequest(Ask("me too"))))
            {
                second.StatusCode.Should().Be(HttpStatusCode.Conflict);
                (await second.Content.ReadFromJsonAsync<JsonObject>())!["error"]!.GetValue<string>().Should().Be("busy");
            }

            await abort.CancelAsync();
            first.Dispose();
            await _server.ClientClosed.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await WaitUntil(() => runs.Any(r => r.ErrorKind == AiErrorKind.Cancelled));
            runs.Should().ContainSingle().Which.Feature.Should().Be(AiFeature.Assistant);
            await WaitUntil(() => !hub.Host.Buddy.IsChatBusy);
        }
        finally
        {
            hub.Host.Ai.Completed -= OnRun;
            _server.HoldOpen = false;
        }

        // The lock is free again.
        _server.Events = [FakeOpenAiServer.Delta("ok"), "data: [DONE]\n\n"];
        (await ChatAsync(Ask("again")))[^1]["errorKind"]!.GetValue<string>().Should().Be("none");
    }

    [Fact]
    public async Task Provider_errors_end_with_their_kind()
    {
        _server.Events = null;
        _server.Status = 401;
        _server.Answer = """{"error":{"message":"bad key"}}""";
        try
        {
            var frames = await ChatAsync(Ask("hi"));

            frames.Select(f => f["type"]!.GetValue<string>()).Should().Equal("meta", "done");
            frames[^1].ToJsonString().Should().Be("""{"type":"done","errorKind":"unauthorized","error":"HTTP 401: bad key"}""");
        }
        finally
        {
            _server.Status = 200;
        }
    }

    [Theory]
    [InlineData("""{"messages":[]}""", "messages")]
    [InlineData("""{}""", "messages")]
    [InlineData("""{"messages":[{"role":"user","text":"a"},{"role":"assistant","text":"b"}]}""", "messages")]
    [InlineData("""{"messages":[{"role":"system","text":"a"}]}""", "messages[0].role")]
    [InlineData("""{"messages":[{"role":"user","text":"  "}]}""", "messages[0].text")]
    public async Task Invalid_requests_are_rejected_per_field(string body, string field)
    {
        using var response = await Http.PostAsync("/v1/assistant/chat", new StringContent(body, Encoding.UTF8, "application/json"));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await response.Content.ReadFromJsonAsync<JsonObject>())!["fields"]!.AsObject().Select(f => f.Key).Should().Equal(field);
    }

    [Fact]
    public async Task Message_count_and_size_are_limited()
    {
        var tooMany = Enumerable.Range(0, 41).Select(i => new { role = i % 2 == 0 ? "user" : "assistant", text = "x" }).ToArray();
        var tooLong = new[] { new { role = "user", text = new string('x', 16_001) }, new { role = "assistant", text = "y" }, new { role = "user", text = new string('x', 16_000) } };

        foreach (var messages in new[] { tooMany, tooLong })
        {
            using var response = await Http.SendAsync(ChatRequest(new { messages }));
            response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
            var fields = (await response.Content.ReadFromJsonAsync<JsonObject>())!["fields"]!.AsObject();
            fields.Select(f => f.Key).Should().Equal("messages");
        }

        var forty = Enumerable.Range(0, 40).Select(i => new { role = i % 2 == 0 ? "assistant" : "user", text = "x" }).ToArray();
        _server.Events = [FakeOpenAiServer.Delta("fine"), "data: [DONE]\n\n"];
        (await ChatAsync(new { messages = forty }))[^1]["errorKind"]!.GetValue<string>().Should().Be("none");
    }

    [Fact]
    public async Task A_turned_off_assistant_refuses_chats_and_hotkeys_must_be_unique()
    {
        var settings = await SettingsAsync();
        settings["buddy"]!["enabled"] = false;
        (await PutSettingsAsync(settings)).StatusCode.Should().Be(HttpStatusCode.OK);
        try
        {
            using var response = await Http.SendAsync(ChatRequest(Ask("hi")));
            response.StatusCode.Should().Be(HttpStatusCode.Conflict);
            (await response.Content.ReadFromJsonAsync<JsonObject>())!["error"]!.GetValue<string>().Should().Be("disabled");
            (await Http.GetFromJsonAsync<JsonObject>("/v1/assistant/info"))!["enabled"]!.GetValue<bool>().Should().BeFalse();
        }
        finally
        {
            settings["buddy"]!["enabled"] = true;
            (await PutSettingsAsync(settings)).StatusCode.Should().Be(HttpStatusCode.OK);
        }

        settings["buddy"]!["hotkey"]!.GetValue<string>().Should().Be("Ctrl+Alt+Space");
        foreach (var (field, taken) in new[] { ("dictation", "hotkey"), ("dictation", "pasteLastHotkey"), ("tasks", "hotkey") })
        {
            var gesture = settings[field]![taken]!.GetValue<string>();
            settings["buddy"]!["hotkey"] = gesture.ToLowerInvariant().Replace("ctrl+alt", "alt+ctrl", StringComparison.Ordinal);
            using var put = await PutSettingsAsync(settings);
            put.StatusCode.Should().Be(HttpStatusCode.BadRequest, $"{gesture} is {field}.{taken}");
            var fields = (await put.Content.ReadFromJsonAsync<JsonObject>())!["fields"]!.AsObject();
            fields.Select(f => f.Key).Should().Equal("buddy.hotkey");
            fields["buddy.hotkey"]![0]!.GetValue<string>().Should().Be($"already used by {field}.{taken}");
        }
    }

    private static async Task WaitUntil(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);
        while (!condition())
        {
            DateTime.UtcNow.Should().BeBefore(deadline, "the condition should hold within 10 s");
            await Task.Delay(20);
        }
    }

    /// <summary>Rendered messages plus every property value and exception, as a log file would show them.</summary>
    private sealed class CapturingSink : ILogEventSink
    {
        private readonly ConcurrentQueue<string> _lines = new();

        public string Text => string.Join('\n', _lines);

        public void Emit(LogEvent logEvent) =>
            _lines.Enqueue(logEvent.RenderMessage(System.Globalization.CultureInfo.InvariantCulture) + " " + string.Join(' ', logEvent.Properties.Values) + " " + logEvent.Exception);
    }
}
