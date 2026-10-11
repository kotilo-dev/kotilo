using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Hub.Core.Ai;
using Hub.Infrastructure.Ai;
using Hub.Infrastructure.Platform;

namespace Hub.Infrastructure.Tests;

public sealed class OpenAiCompatibleProviderTests
{
    private sealed class StubHandler(Func<HttpRequestMessage, string?, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        public List<(HttpRequestMessage Request, string? Body)> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add((request, body));
            return await respond(request, body).WaitAsync(cancellationToken);
        }
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string json) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private static readonly AiRequest Request = new("Be brief.", "Say hi", null, TimeSpan.FromSeconds(5));

    [Theory]
    [InlineData("http://localhost:11434", "http://localhost:11434/v1")]
    [InlineData("http://localhost:11434/", "http://localhost:11434/v1")]
    [InlineData("http://localhost:11434/v1/", "http://localhost:11434/v1")]
    [InlineData("https://gw.example.com/openai/v1", "https://gw.example.com/openai/v1")]
    [InlineData("https://gw.example.com/openai", "https://gw.example.com/openai/v1")]
    [InlineData("http://v1:8080", "http://v1:8080/v1")]
    public void Base_url_is_accepted_with_or_without_v1(string baseUrl, string root) => OpenAiCompatibleProvider.ApiRoot(baseUrl).Should().Be(root);

    [Fact]
    public async Task Posts_chat_completions_with_system_user_and_bearer_key()
    {
        var handler = new StubHandler((_, _) => Task.FromResult(Json(HttpStatusCode.OK,
            """{"model":"llama3:8b","choices":[{"message":{"role":"assistant","content":"<think>hmm</think>\n Hi there "}}]}""")));
        using var http = new HttpClient(handler);
        var provider = new OpenAiCompatibleProvider("ollama", "http://localhost:11434", "llama3", () => "sk-test", http);

        var result = await provider.CompleteAsync(Request, CancellationToken.None);

        result.Should().Be(AiResult.Ok("Hi there", "llama3:8b"));
        provider.Id.Should().Be("openai:ollama");
        var (request, body) = handler.Requests.Should().ContainSingle().Subject;
        request.RequestUri!.ToString().Should().Be("http://localhost:11434/v1/chat/completions");
        request.Method.Should().Be(HttpMethod.Post);
        request.Headers.Authorization!.ToString().Should().Be("Bearer sk-test");
        using var doc = JsonDocument.Parse(body!);
        doc.RootElement.GetProperty("model").GetString().Should().Be("llama3");
        doc.RootElement.GetProperty("stream").GetBoolean().Should().BeFalse();
        doc.RootElement.GetProperty("messages").EnumerateArray().Select(m => (m.GetProperty("role").GetString(), m.GetProperty("content").GetString()))
            .Should().Equal(("system", "Be brief."), ("user", "Say hi"));
    }

    [Fact]
    public async Task Request_model_wins_and_no_key_sends_no_header()
    {
        var handler = new StubHandler((_, _) => Task.FromResult(Json(HttpStatusCode.OK, """{"choices":[{"message":{"content":"ok"}}]}""")));
        using var http = new HttpClient(handler);
        var provider = new OpenAiCompatibleProvider("lm", "http://127.0.0.1:1234/v1", "default", () => null, http);

        var result = await provider.CompleteAsync(Request with { Model = "qwen3" }, CancellationToken.None);

        result.Should().Be(AiResult.Ok("ok", "qwen3"));
        handler.Requests[0].Request.Headers.Authorization.Should().BeNull();
        handler.Requests[0].Body.Should().Contain("\"model\":\"qwen3\"");
    }

    [Fact]
    public async Task Missing_model_is_not_configured_without_a_request()
    {
        var handler = new StubHandler((_, _) => throw new InvalidOperationException("must not be called"));
        using var http = new HttpClient(handler);

        var result = await new OpenAiCompatibleProvider("x", "http://localhost:1", null, () => null, http).CompleteAsync(Request, CancellationToken.None);

        result.ErrorKind.Should().Be(AiErrorKind.NotConfigured);
        handler.Requests.Should().BeEmpty();
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, AiErrorKind.Unauthorized, "HTTP 401: bad key")]
    [InlineData(HttpStatusCode.Forbidden, AiErrorKind.Unauthorized, "HTTP 403: bad key")]
    [InlineData(HttpStatusCode.NotFound, AiErrorKind.Failed, "HTTP 404: bad key")]
    [InlineData(HttpStatusCode.InternalServerError, AiErrorKind.Failed, "HTTP 500: bad key")]
    public async Task Http_errors_map_to_kinds_with_a_short_detail(HttpStatusCode status, AiErrorKind kind, string detail)
    {
        var handler = new StubHandler((_, _) => Task.FromResult(Json(status, """{"error":{"message":"bad key\nmore"}}""")));
        using var http = new HttpClient(handler);

        var result = await new OpenAiCompatibleProvider("x", "http://localhost:1", "m", () => "k", http).CompleteAsync(Request, CancellationToken.None);

        (result.ErrorKind, result.Detail, result.Text).Should().Be((kind, detail, null));
    }

    [Fact]
    public async Task An_answer_without_content_fails()
    {
        var handler = new StubHandler((_, _) => Task.FromResult(Json(HttpStatusCode.OK, """{"choices":[]}""")));
        using var http = new HttpClient(handler);

        var result = await new OpenAiCompatibleProvider("x", "http://localhost:1", "m", () => null, http).CompleteAsync(Request, CancellationToken.None);

        result.ErrorKind.Should().Be(AiErrorKind.Failed);
    }

    [Fact]
    public async Task A_closed_port_is_unreachable()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        using var http = new HttpClient();

        var result = await new OpenAiCompatibleProvider("x", $"http://127.0.0.1:{port}", "m", () => null, http).CompleteAsync(Request, CancellationToken.None);

        result.ErrorKind.Should().Be(AiErrorKind.Unreachable);
    }

    [Fact]
    public async Task Slow_endpoints_time_out_and_callers_can_cancel()
    {
        var handler = new StubHandler(async (_, _) =>
        {
            await Task.Delay(Timeout.Infinite);
            return new HttpResponseMessage();
        });
        using var http = new HttpClient(handler);
        var provider = new OpenAiCompatibleProvider("x", "http://localhost:1", "m", () => null, http);

        (await provider.CompleteAsync(Request with { Timeout = TimeSpan.FromMilliseconds(100) }, CancellationToken.None)).ErrorKind.Should().Be(AiErrorKind.Timeout);

        using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        (await provider.CompleteAsync(Request, cancel.Token)).ErrorKind.Should().Be(AiErrorKind.Cancelled);
    }

    [Fact]
    public async Task Models_are_listed_from_the_models_route()
    {
        var handler = new StubHandler((_, _) => Task.FromResult(Json(HttpStatusCode.OK, """{"data":[{"id":"b"},{"id":"a"},{"x":1}]}""")));
        using var http = new HttpClient(handler);

        var list = await new OpenAiCompatibleProvider("x", "http://localhost:1/v1", null, () => null, http).ListModelsAsync(TimeSpan.FromSeconds(5), CancellationToken.None);

        list.Models.Should().Equal("a", "b");
        handler.Requests[0].Request.RequestUri!.ToString().Should().Be("http://localhost:1/v1/models");
    }
}

/// <summary>A fake agent CLI: <c>.cmd</c> scripts in a temp folder (Windows only; the runner's platform layer is what is tested).</summary>
public sealed class CliAiProviderTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private string Scratch => _dir.File("scratch");

    private string Script(string name, string body)
    {
        var path = _dir.File(name);
        File.WriteAllText(path, "@echo off\r\n" + body.ReplaceLineEndings("\r\n") + "\r\n");
        return path;
    }

    private static CliAgentSpec Spec(CliPromptInput input, Dictionary<int, string>? exitCodes = null) => new(
        "fake", "Fake", Verified: false, ["fake"], [], input, CliOutput.PlainText, HasSystemPromptFlag: false,
        i => i.Prompt is null ? ["--model", i.Model ?? "none"] : ["--model", i.Model ?? "none", i.Prompt])
    {
        ExitCodes = exitCodes ?? new Dictionary<int, string>(),
        Environment = new Dictionary<string, string> { ["FAKE_SPEC_ENV"] = "on" },
    };

    private CliAiProvider Provider(string? exe, CliAgentSpec spec) => new(spec, () => exe, Scratch);

    private static AiRequest Req(string user, string? model = "m1", double seconds = 20, string system = "Rules.") =>
        new(system, user, model, TimeSpan.FromSeconds(seconds));

    [Fact]
    public async Task Runs_in_the_scratch_folder_with_the_internal_marker_and_spec_env()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var exe = Script("fake.cmd", "echo cwd=%CD%\necho internal=%AGENTHUB_INTERNAL% spec=%FAKE_SPEC_ENV% args=%1 %2");

        // Without a system prompt the argument is plain enough for the cmd fallback (an unresolvable shim).
        var result = await Provider(exe, Spec(CliPromptInput.Argument)).CompleteAsync(Req("hello world", system: ""), CancellationToken.None);

        result.ErrorKind.Should().Be(AiErrorKind.None);
        result.Text.Should().Be($"cwd={Scratch}\r\ninternal=1 spec=on args=--model m1");
        result.Model.Should().Be("m1");
    }

    [Fact]
    public async Task Stdin_specs_get_the_combined_prompt_on_stdin()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var exe = Script("fake.cmd", "findstr \"^\"");

        var result = await Provider(exe, Spec(CliPromptInput.Stdin)).CompleteAsync(Req("100% & \"quoted\" | piped"), CancellationToken.None);

        result.Text.Should().Be("Rules.\r\n\r\n---\r\n\r\n100% & \"quoted\" | piped", "free text never passes through cmd.exe parsing");
    }

    [Fact]
    public async Task Free_text_is_never_passed_through_cmd_exe()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var marker = _dir.File("pwned.txt");
        var exe = Script("fake.cmd", "echo should not run");

        var result = await Provider(exe, Spec(CliPromptInput.Argument)).CompleteAsync(Req($"x\" & echo pwned > \"{marker}"), CancellationToken.None);

        (result.ErrorKind, result.Detail).Should().Be((AiErrorKind.Failed, "unsafeShim"));
        File.Exists(marker).Should().BeFalse();
    }

    [Fact]
    public async Task Login_errors_known_exit_codes_and_empty_output_are_mapped()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var spec = Spec(CliPromptInput.Stdin, new Dictionary<int, string> { [55] = "tools" });
        var login = Script("login.cmd", "echo Not logged in. Please run /login 1>&2\nexit /b 1");
        var tools = Script("tools.cmd", "echo partial\nexit /b 55");
        var empty = Script("empty.cmd", "exit /b 0");
        var crash = Script("crash.cmd", "echo boom 1>&2\nexit /b 3");

        (await Provider(login, spec).CompleteAsync(Req("x"), CancellationToken.None)).ErrorKind.Should().Be(AiErrorKind.NotLoggedIn);
        var qwenLogin = Script("qwen-login.cmd", "echo No auth type is selected. Please configure an auth type before running in non-interactive mode. 1>&2\nexit /b 1");
        (await Provider(qwenLogin, spec).CompleteAsync(Req("x"), CancellationToken.None)).ErrorKind.Should().Be(AiErrorKind.NotLoggedIn);
        (await Provider(tools, spec).CompleteAsync(Req("x"), CancellationToken.None)).Should().Be(AiResult.Error(AiErrorKind.Failed, "tools"));
        (await Provider(empty, spec).CompleteAsync(Req("x"), CancellationToken.None)).Should().Be(AiResult.Error(AiErrorKind.Failed, "empty"));
        (await Provider(crash, spec).CompleteAsync(Req("x"), CancellationToken.None)).Should().Be(AiResult.Error(AiErrorKind.Failed, "exit 3: boom"));
        (await Provider(null, spec).CompleteAsync(Req("x"), CancellationToken.None)).ErrorKind.Should().Be(AiErrorKind.NotInstalled);
        (await Provider(crash, spec).CompleteAsync(Req("x", model: "bad model"), CancellationToken.None)).Should().Be(AiResult.Error(AiErrorKind.Failed, "invalidModel"));
    }

    [Fact]
    public async Task Slow_runs_time_out_or_cancel_and_the_process_is_killed()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var exe = Script("slow.cmd", "ping -n 30 127.0.0.1 >nul\necho late");
        var provider = Provider(exe, Spec(CliPromptInput.Stdin));

        var started = DateTime.UtcNow;
        (await provider.CompleteAsync(Req("x", seconds: 1), CancellationToken.None)).ErrorKind.Should().Be(AiErrorKind.Timeout);
        using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
        (await provider.CompleteAsync(Req("x"), cancel.Token)).ErrorKind.Should().Be(AiErrorKind.Cancelled);
        (DateTime.UtcNow - started).Should().BeLessThan(TimeSpan.FromSeconds(15));
    }

    [Fact]
    public async Task Claude_stream_runs_answer_and_runs_with_tools_are_stopped()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        const string Init = """{"type":"system","subtype":"init","session_id":"s1","tools":[],"model":"claude-haiku-test"}""";
        const string ToolsInit = """{"type":"system","subtype":"init","session_id":"s1","tools":["Bash"],"model":"claude-haiku-test"}""";
        const string Text = """{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Merhaba"}]}}""";
        const string Result = """{"type":"result","subtype":"success","is_error":false,"result":"Merhaba","session_id":"s1","usage":{"input_tokens":3,"output_tokens":1}}""";
        File.WriteAllLines(_dir.File("ok.jsonl"), [Init, Text, Result]);
        File.WriteAllLines(_dir.File("tools.jsonl"), [ToolsInit, Text, Result]);
        CliAiProvider Claude(string stream) => new(CliAgentSpecs.ClaudeCode, () => Script(stream + ".cmd", $"type \"%~dp0{stream}.jsonl\""), Scratch);
        var request = new AiRequest("safe system", "Selam", "haiku", TimeSpan.FromSeconds(20));

        (await Claude("ok").CompleteAsync(request, CancellationToken.None)).Should().Be(AiResult.Ok("Merhaba", "claude-haiku-test"));
        var stopped = await Claude("tools").CompleteAsync(request, CancellationToken.None);
        (stopped.ErrorKind, stopped.Detail).Should().Be((AiErrorKind.Failed, "tools"));
    }

    [Fact]
    public void Npm_shims_resolve_to_their_native_exe_or_node_script()
    {
        var npm = Directory.CreateDirectory(_dir.File("npm")).FullName;
        var exe = Path.Combine(npm, "node_modules", "@x", "cli", "bin", "tool.exe");
        var script = Path.Combine(npm, "node_modules", "@y", "cli", "loader.js");
        Directory.CreateDirectory(Path.GetDirectoryName(exe)!);
        Directory.CreateDirectory(Path.GetDirectoryName(script)!);
        File.WriteAllText(exe, "");
        File.WriteAllText(script, "");
        File.WriteAllText(Path.Combine(npm, "node.exe"), "");
        File.WriteAllText(Path.Combine(npm, "tool.cmd"), "@ECHO off\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\@x\\cli\\bin\\tool.exe\"   %*\r\n");
        File.WriteAllText(Path.Combine(npm, "loader.cmd"),
            "IF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@y\\cli\\loader.js\" %*\r\n");
        File.WriteAllText(Path.Combine(npm, "broken.cmd"), "@echo off\r\nsomething else %*\r\n");

        CliLaunch.Plan(Path.Combine(npm, "tool.cmd"), ["a & b"]).Should().BeEquivalentTo(new CliLaunchPlan(exe, []));
        CliLaunch.Plan(Path.Combine(npm, "loader.cmd"), ["x"]).Should().BeEquivalentTo(new CliLaunchPlan(Path.Combine(npm, "node.exe"), [script]));
        CliLaunch.Plan(Path.Combine(npm, "broken.cmd"), ["--model", "m1", "-"]).Should().BeEquivalentTo(
            new CliLaunchPlan("cmd.exe", ["/d", "/c", Path.Combine(npm, "broken.cmd")]));
        CliLaunch.Plan(Path.Combine(npm, "broken.cmd"), ["100%"]).Should().BeNull();
        CliLaunch.Plan(@"C:\x\tool.exe", ["anything \" & |"]).Should().BeEquivalentTo(new CliLaunchPlan(@"C:\x\tool.exe", []));
    }

    [Fact]
    public void Locator_searches_path_then_known_dirs_and_keeps_generic_names_out_of_path()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var onPath = Directory.CreateDirectory(_dir.File("p")).FullName;
        var profile = Directory.CreateDirectory(_dir.File("home")).FullName;
        var npm = Directory.CreateDirectory(Path.Combine(profile, "AppData", "Roaming", "npm")).FullName;
        var cursorDir = Directory.CreateDirectory(Path.Combine(profile, "AppData", "Local", "cursor-agent")).FullName;

        CliAgentLocator.Find(CliAgentSpecs.Copilot, onPath, profile).Should().BeNull();
        File.WriteAllText(Path.Combine(npm, "copilot"), "");
        CliAgentLocator.Find(CliAgentSpecs.Copilot, onPath, profile).Should().BeNull("the extension-less sh shim is not for Windows");
        File.WriteAllText(Path.Combine(npm, "copilot.cmd"), "");
        CliAgentLocator.Find(CliAgentSpecs.Copilot, onPath, profile).Should().Be(Path.Combine(npm, "copilot.cmd"));

        File.WriteAllText(Path.Combine(onPath, "agent.exe"), "");
        CliAgentLocator.Find(CliAgentSpecs.Cursor, onPath, profile).Should().BeNull("a generic 'agent' on PATH may be anything");
        File.WriteAllText(Path.Combine(cursorDir, "agent.exe"), "");
        CliAgentLocator.Find(CliAgentSpecs.Cursor, onPath, profile).Should().Be(Path.Combine(cursorDir, "agent.exe"));
        File.WriteAllText(Path.Combine(onPath, "cursor-agent.cmd"), "");
        CliAgentLocator.Find(CliAgentSpecs.Cursor, onPath, profile).Should().Be(Path.Combine(onPath, "cursor-agent.cmd"));
    }

    [Fact]
    public void Ansi_sequences_are_removed_from_plain_answers() =>
        CliAiProvider.Clean("\u001b[32mOK\u001b[0m\r\n\u001b]0;title\u0007").Should().Be("OK");

    [Fact]
    public void In_memory_store_round_trips()
    {
        var store = new InMemorySecretStore();
        store.Write("Ollama", "k1");
        store.Read("ollama").Should().Be("k1");
        store.Delete("OLLAMA").Should().BeTrue();
        store.Read("ollama").Should().BeNull();
        store.Delete("ollama").Should().BeFalse();
        new UnavailableSecretStore().Invoking(s => s.Write("a", "b")).Should().Throw<PlatformNotSupportedException>();
        new WindowsCredentialStore(Hub.Core.Brand.Current.CredentialPrefix, "u").Target("ollama").Should().Be(Hub.Core.Brand.Current.Slug + "/ai/ollama");
    }

    [Fact]
    public void Migrating_store_moves_a_legacy_key_to_the_current_name_once()
    {
        var current = new InMemorySecretStore();
        var older = new InMemorySecretStore();
        var oldest = new InMemorySecretStore();
        older.Write("ollama", "k-older");
        oldest.Write("ollama", "k-oldest");
        oldest.Write("lmstudio", "k-lm");
        var store = new MigratingSecretStore(current, [older, oldest]);

        store.Read("ollama").Should().Be("k-older", "the first legacy store that has the key wins");
        current.Read("ollama").Should().Be("k-older");
        older.Read("ollama").Should().BeNull("the key lives in one place again");
        store.Read("lmstudio").Should().Be("k-lm");
        oldest.Read("lmstudio").Should().BeNull();
        store.Read("missing").Should().BeNull();

        store.Write("openai", "k-new");
        older.Read("openai").Should().BeNull("writes go to the current store only");
        store.Delete("ollama").Should().BeTrue();
        oldest.Read("ollama").Should().BeNull("delete clears every copy");
        current.Read("ollama").Should().BeNull();
    }
}

/// <summary>Streaming chat over an OpenAI-compatible endpoint: the response body is fed chunk by chunk by the test.</summary>
public sealed class OpenAiChatStreamTests
{
    /// <summary>A response body the test writes to while the provider reads it.</summary>
    private sealed class ChunkStream : Stream
    {
        private readonly System.Threading.Channels.Channel<byte[]> _chunks = System.Threading.Channels.Channel.CreateUnbounded<byte[]>();
        private byte[] _current = [];
        private int _offset;

        public void Write(string text) => _chunks.Writer.TryWrite(Encoding.UTF8.GetBytes(text));

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_offset >= _current.Length)
            {
                if (!await _chunks.Reader.WaitToReadAsync(cancellationToken))
                {
                    return 0;
                }

                _current = await _chunks.Reader.ReadAsync(cancellationToken);
                _offset = 0;
            }

            var n = Math.Min(buffer.Length, _current.Length - _offset);
            _current.AsMemory(_offset, n).CopyTo(buffer);
            _offset += n;
            return n;
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer, offset, count, CancellationToken.None).GetAwaiter().GetResult();

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class Handler(Func<HttpResponseMessage> respond) : HttpMessageHandler
    {
        public string? Body { get; private set; }

        public string? Accept { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Body = await request.Content!.ReadAsStringAsync(cancellationToken);
            Accept = request.Headers.Accept.ToString();
            return respond();
        }
    }

    /// <summary>Collects <c>onText</c> calls and lets the test wait for a given text.</summary>
    private sealed class Texts
    {
        private readonly List<string> _all = [];
        private readonly List<(string Text, TaskCompletionSource Seen)> _waits = [];

        public IReadOnlyList<string> All
        {
            get
            {
                lock (_all)
                {
                    return _all.ToList();
                }
            }
        }

        public void Add(string text)
        {
            lock (_all)
            {
                _all.Add(text);
                foreach (var w in _waits.Where(w => w.Text == text))
                {
                    w.Seen.TrySetResult();
                }
            }
        }

        public Task WaitFor(string text)
        {
            lock (_all)
            {
                var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                if (_all.Contains(text))
                {
                    tcs.SetResult();
                }

                _waits.Add((text, tcs));
                return tcs.Task.WaitAsync(TimeSpan.FromSeconds(10));
            }
        }
    }

    private static readonly AiChatRequest Chat = new(
        "Be brief.", [new(AiChatRole.User, "hi"), new(AiChatRole.Assistant, "hello"), new(AiChatRole.User, "say more")], null, TimeSpan.FromSeconds(10));

    private static string Delta(string text, string model = "m-live") =>
        "data: " + JsonSerializer.Serialize(new { model, choices = new[] { new { delta = new { content = text } } } }) + "\n\n";

    private static HttpResponseMessage Sse(ChunkStream body)
    {
        var content = new StreamContent(body);
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("text/event-stream");
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
    }

    [Fact]
    public async Task Chunks_are_passed_on_as_they_arrive()
    {
        var body = new ChunkStream();
        var handler = new Handler(() => Sse(body));
        using var http = new HttpClient(handler);
        var provider = new OpenAiCompatibleProvider("ollama", "http://localhost:11434", "llama3", () => "sk-test", http);
        var texts = new Texts();

        var run = provider.ChatAsync(Chat, texts.Add, CancellationToken.None);
        body.Write(": keep-alive\n\n" + Delta("<think>hmm"));
        body.Write(Delta("</think>Hel"));
        await texts.WaitFor("Hel");
        run.IsCompleted.Should().BeFalse("the answer is still streaming");
        body.Write(Delta("lo "));
        body.Write("data: [DONE]\n\n");
        var result = await run;

        result.Should().Be(AiResult.Ok("Hello", "m-live"));
        texts.All.Should().Equal("Hel", "Hello ");
        handler.Accept.Should().Contain("text/event-stream");
        using var doc = JsonDocument.Parse(handler.Body!);
        doc.RootElement.GetProperty("stream").GetBoolean().Should().BeTrue();
        doc.RootElement.GetProperty("model").GetString().Should().Be("llama3");
        doc.RootElement.GetProperty("messages").EnumerateArray().Select(m => (m.GetProperty("role").GetString(), m.GetProperty("content").GetString()))
            .Should().Equal(("system", "Be brief."), ("user", "hi"), ("assistant", "hello"), ("user", "say more"));
    }

    [Fact]
    public async Task A_server_that_does_not_stream_answers_with_one_json_body()
    {
        var handler = new Handler(() => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("""{"model":"m-json","choices":[{"message":{"content":" Whole answer "}}]}""", Encoding.UTF8, "application/json"),
        });
        using var http = new HttpClient(handler);
        var texts = new Texts();

        var result = await new OpenAiCompatibleProvider("x", "http://localhost:1", "m", () => null, http).ChatAsync(Chat, texts.Add, CancellationToken.None);

        result.Should().Be(AiResult.Ok("Whole answer", "m-json"));
        texts.All.Should().Equal("Whole answer");
    }

    [Fact]
    public async Task Event_streams_without_the_content_type_and_error_events_are_read()
    {
        var plain = new Handler(() => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Delta("A") + Delta("B") + "data: [DONE]\n") });
        using var http = new HttpClient(plain);
        (await new OpenAiCompatibleProvider("x", "http://localhost:1", "m", () => null, http).ChatAsync(Chat, _ => { }, CancellationToken.None))
            .Should().Be(AiResult.Ok("AB", "m-live"));

        var failing = new Handler(() => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(Delta("A") + """data: {"error":{"message":"overloaded"}}""" + "\n\n"),
        });
        using var http2 = new HttpClient(failing);
        var result = await new OpenAiCompatibleProvider("x", "http://localhost:1", "m", () => null, http2).ChatAsync(Chat, _ => { }, CancellationToken.None);
        (result.ErrorKind, result.Detail).Should().Be((AiErrorKind.Failed, "HTTP 200: overloaded"));
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, AiErrorKind.Unauthorized)]
    [InlineData(HttpStatusCode.NotFound, AiErrorKind.Failed)]
    public async Task Error_statuses_map_to_kinds_and_send_no_text(HttpStatusCode status, AiErrorKind kind)
    {
        var handler = new Handler(() => new HttpResponseMessage(status) { Content = new StringContent("""{"error":"nope"}""") });
        using var http = new HttpClient(handler);
        var texts = new Texts();

        var result = await new OpenAiCompatibleProvider("x", "http://localhost:1", "m", () => "k", http).ChatAsync(Chat, texts.Add, CancellationToken.None);

        (result.ErrorKind, result.Detail).Should().Be((kind, $"HTTP {(int)status}: nope"));
        texts.All.Should().BeEmpty();
    }

    [Fact]
    public async Task Cancelling_mid_stream_stops_the_read()
    {
        var body = new ChunkStream();
        using var http = new HttpClient(new Handler(() => Sse(body)));
        var texts = new Texts();
        using var cancel = new CancellationTokenSource();

        var run = new OpenAiCompatibleProvider("x", "http://localhost:1", "m", () => null, http).ChatAsync(Chat, texts.Add, cancel.Token);
        body.Write(Delta("Part"));
        await texts.WaitFor("Part");
        await cancel.CancelAsync();
        var result = await run.WaitAsync(TimeSpan.FromSeconds(10));

        result.ErrorKind.Should().Be(AiErrorKind.Cancelled);
        texts.All.Should().Equal("Part");
    }

    [Fact]
    public async Task A_stalled_stream_times_out()
    {
        var body = new ChunkStream();
        using var http = new HttpClient(new Handler(() => Sse(body)));

        var result = await new OpenAiCompatibleProvider("x", "http://localhost:1", "m", () => null, http)
            .ChatAsync(Chat with { Timeout = TimeSpan.FromMilliseconds(300) }, _ => { }, CancellationToken.None);

        result.ErrorKind.Should().Be(AiErrorKind.Timeout);
    }
}

/// <summary>Chat runs of a fake agent CLI (<c>.cmd</c> scripts, Windows only).</summary>
public sealed class CliChatTests : IDisposable
{
    private static readonly AiChatMessage[] Conversation =
        [new(AiChatRole.User, "2+2?"), new(AiChatRole.Assistant, "4."), new(AiChatRole.User, "100% & \"times\" | 3?")];

    /// <summary>Plain-text, stdin, with a made-up no-persistence flag for chat runs.</summary>
    private static readonly CliAgentSpec Plain = new(
        "fake", "Fake", Verified: false, ["fake"], [], CliPromptInput.Stdin, CliOutput.PlainText, HasSystemPromptFlag: false,
        i => i.Ephemeral ? ["--model", i.Model ?? "none", "--no-persist"] : ["--model", i.Model ?? "none"])
    {
        Ephemeral = true,
    };

    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private string Scratch => _dir.File("scratch");

    private string Script(string name, string body)
    {
        var path = _dir.File(name);
        File.WriteAllText(path, "@echo off\r\n" + body.ReplaceLineEndings("\r\n") + "\r\n");
        return path;
    }

    private static AiChatRequest Chat() => new("Rules.", Conversation, "m1", TimeSpan.FromSeconds(20));

    [Fact]
    public async Task Plain_clis_get_the_rendered_conversation_on_stdin_and_the_no_persistence_flag()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var exe = Script("fake.cmd", "echo args=%*\nfindstr \"^\"");
        var texts = new List<string>();

        var result = await new CliAiProvider(Plain, () => exe, Scratch).ChatAsync(Chat(), texts.Add, CancellationToken.None);

        var expected = "args=--model m1 --no-persist\n" + CliAgentSpecs.CombinePrompt("Rules.", AiChatPrompt.Render(Conversation));
        result.Should().Be(AiResult.Ok(expected.ReplaceLineEndings("\r\n"), "m1"));
        texts.Should().Equal([result.Text!], "the answer arrives once, at the end");
    }

    [Fact]
    public async Task Claude_chats_stream_and_run_without_session_persistence()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        const string Init = """{"type":"system","subtype":"init","session_id":"s1","tools":[],"model":"claude-haiku-test"}""";
        const string Text = """{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Twelve."}]}}""";
        const string Result = """{"type":"result","subtype":"success","is_error":false,"result":"Twelve.","session_id":"s1","usage":{"input_tokens":3,"output_tokens":1}}""";
        File.WriteAllLines(_dir.File("ok.jsonl"), [Init, Text, Result]);
        var exe = Script("claude.cmd", "echo %* > \"%~dp0args.txt\"\nfindstr \"^\" > \"%~dp0stdin.txt\"\ntype \"%~dp0ok.jsonl\"");
        var texts = new List<string>();

        var result = await new CliAiProvider(CliAgentSpecs.ClaudeCode, () => exe, Scratch)
            .ChatAsync(Chat() with { System = "safe system", Model = "haiku" }, texts.Add, CancellationToken.None);

        result.Should().Be(AiResult.Ok("Twelve.", "claude-haiku-test"));
        texts.Should().Equal("Twelve.");
        File.ReadAllText(_dir.File("args.txt")).Should().Contain("--no-session-persistence").And.Contain("--append-system-prompt").And.NotContain("--resume");
        File.ReadAllText(_dir.File("stdin.txt")).ReplaceLineEndings("\n").TrimEnd().Should().Be(AiChatPrompt.Render(Conversation));
    }

    [Fact]
    public async Task Cancelling_a_chat_kills_the_process_tree()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        // ping holds the output pipe: the run only ends this early if the whole tree is gone.
        var exe = Script("slow.cmd", "ping -n 30 127.0.0.1 >nul\necho late");
        using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
        var started = DateTime.UtcNow;

        var result = await new CliAiProvider(Plain, () => exe, Scratch).ChatAsync(Chat(), _ => { }, cancel.Token);

        result.ErrorKind.Should().Be(AiErrorKind.Cancelled);
        (DateTime.UtcNow - started).Should().BeLessThan(TimeSpan.FromSeconds(15));
    }

    [Fact]
    public void The_claude_locator_prefers_exe_on_path_then_local_bin()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var onPath = Directory.CreateDirectory(_dir.File("p")).FullName;
        var profile = Directory.CreateDirectory(_dir.File("home")).FullName;
        var localBin = Directory.CreateDirectory(Path.Combine(profile, ".local", "bin")).FullName;

        CliAgentLocator.Find(CliAgentSpecs.ClaudeCode, onPath, profile).Should().BeNull();

        File.WriteAllText(Path.Combine(localBin, "claude.exe"), "");
        CliAgentLocator.Find(CliAgentSpecs.ClaudeCode, onPath, profile).Should().Be(Path.Combine(localBin, "claude.exe"));

        File.WriteAllText(Path.Combine(onPath, "claude.cmd"), "");
        CliAgentLocator.Find(CliAgentSpecs.ClaudeCode, onPath, profile).Should().Be(Path.Combine(localBin, "claude.exe"), ".exe wins over .cmd");

        File.WriteAllText(Path.Combine(onPath, "claude.exe"), "");
        CliAgentLocator.Find(CliAgentSpecs.ClaudeCode, $"\"{onPath}\";;", profile).Should().Be(Path.Combine(onPath, "claude.exe"));
    }
}
