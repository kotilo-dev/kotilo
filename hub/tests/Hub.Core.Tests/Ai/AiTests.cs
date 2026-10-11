using Hub.Core.Ai;

namespace Hub.Core.Tests.Ai;

public class AiProviderIdsTests
{
    [Theory]
    [InlineData("cli:codex", "cli", "codex")]
    [InlineData("openai:ollama", "openai", "ollama")]
    [InlineData("openai:lm.studio-2", "openai", "lm.studio-2")]
    public void Ids_split_into_kind_and_name(string id, string kind, string name)
    {
        AiProviderIds.TryParse(id, out var k, out var n).Should().BeTrue();
        (k, n).Should().Be((kind, name));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("cli:")]
    [InlineData("codex")]
    [InlineData("openai-compatible:x")]
    public void Other_ids_are_rejected(string? id) => AiProviderIds.TryParse(id, out _, out _).Should().BeFalse();

    [Theory]
    [InlineData("haiku", true)]
    [InlineData("gpt-5.1-codex", true)]
    [InlineData("llama3.1:8b", true)]
    [InlineData("openai/gpt-4o#high", true)]
    [InlineData("claude-opus-4[1m]", true)]
    [InlineData("", false)]
    [InlineData("-m", false)]
    [InlineData("a b", false)]
    [InlineData("x\"&calc", false)]
    [InlineData("%PATH%", false)]
    public void Models_use_a_command_line_safe_character_set(string model, bool valid) => AiProviderIds.IsValidModel(model).Should().Be(valid);

    [Theory]
    [InlineData("ollama", true)]
    [InlineData("corp_gw-1.eu", true)]
    [InlineData("", false)]
    [InlineData("a/b", false)]
    [InlineData("has space", false)]
    [InlineData(".hidden", false)]
    public void Provider_names_are_path_and_vault_safe(string name, bool valid) => AiProviderIds.IsValidName(name).Should().Be(valid);

    [Theory]
    [InlineData("http://localhost:11434", true)]
    [InlineData("https://gw.example.com/openai/v1", true)]
    [InlineData("ftp://x", false)]
    [InlineData("http://user:pw@x", false)]
    [InlineData("http://x/v1?key=1", false)]
    [InlineData("localhost:11434", false)]
    public void Base_urls_are_plain_http_urls(string url, bool valid) => AiProviderIds.IsValidBaseUrl(url).Should().Be(valid);

    [Theory]
    [InlineData("http://localhost:11434/v1", true)]
    [InlineData("http://LOCALHOST", true)]
    [InlineData("http://ollama.localhost", true)]
    [InlineData("http://127.0.0.1:1234", true)]
    [InlineData("http://127.10.0.5", true)]
    [InlineData("http://[::1]:8080", true)]
    [InlineData("http://192.168.1.10:11434", false)]
    [InlineData("https://api.example.com", false)]
    [InlineData("http://localhost.evil.com", false)]
    public void Loopback_hosts_are_recognised(string url, bool loopback) => AiProviderIds.IsLoopback(url).Should().Be(loopback);

    [Fact]
    public void Fully_local_needs_every_enabled_feature_on_a_loopback_endpoint()
    {
        var local = new AiSettings
        {
            Providers = [new AiProviderConfig { Name = "ollama", BaseUrl = "http://localhost:11434", Model = "llama3" }, new AiProviderConfig { Name = "corp", BaseUrl = "https://llm.corp.example" }],
            Assistant = new AiFeatureChoice { Provider = "openai:ollama" },
            DailySummary = new AiFeatureChoice { Provider = "openai:ollama" },
            DictationCleanup = new AiFeatureChoice { Provider = "cli:claude-code", Model = "haiku" },
        };
        AiFeature[] all = [AiFeature.Assistant, AiFeature.DailySummary, AiFeature.DictationCleanup];

        AiProviderIds.IsFullyLocal(local, all).Should().BeFalse("the cleanup runs an agent CLI");
        AiProviderIds.IsFullyLocal(local, [AiFeature.Assistant, AiFeature.DailySummary]).Should().BeTrue("the CLI feature is switched off");
        AiProviderIds.IsFullyLocal(local with { Assistant = new AiFeatureChoice { Provider = "openai:corp" } }, [AiFeature.Assistant]).Should().BeFalse();
        AiProviderIds.IsFullyLocal(local with { Assistant = new AiFeatureChoice { Provider = "openai:missing" } }, [AiFeature.Assistant]).Should().BeFalse();
        AiProviderIds.IsFullyLocal(local, []).Should().BeTrue();
    }

    [Fact]
    public void Legacy_model_aliases_become_claude_code_choices()
    {
        var ai = AiSettings.FromLegacy("sonnet", null, " opus ");

        ai.Assistant.Should().Be(new AiFeatureChoice { Provider = "cli:claude-code", Model = "sonnet" });
        ai.DailySummary.Should().Be(new AiFeatureChoice { Provider = "cli:claude-code", Model = "haiku" });
        ai.DictationCleanup.Should().Be(new AiFeatureChoice { Provider = "cli:claude-code", Model = "opus" });
        ai.Providers.Should().BeEmpty();
        new AiSettings().DailySummary.Should().Be(ai.DailySummary, "a new install keeps the pre-M3 default");
    }
}

public class CliAgentSpecsTests
{
    private static readonly string[] Forbidden =
    [
        "--yolo", "--auto", "--allow-all", "--allow-all-tools", "--allow-all-paths", "--allow-all-urls", "--force",
        "--skip-permissions-unsafe", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-skip-permissions", "--full-auto",
    ];

    private static List<string> Args(CliAgentSpec spec, string? model = "m1") =>
        spec.Arguments(new CliInvocation(spec.PromptInput == CliPromptInput.Argument ? "PROMPT" : null, "SYS", model, @"C:\scratch")).ToList();

    [Fact]
    public void Every_agent_has_a_spec_and_none_auto_approves()
    {
        CliAgentSpecs.All.Select(s => s.AdapterId).Should().Equal("claude-code", "codex", "copilot", "opencode", "gemini", "qwen", "droid", "cursor");
        foreach (var spec in CliAgentSpecs.All)
        {
            var args = Args(spec);
            args.Should().NotContain(a => Forbidden.Contains(a), spec.AdapterId);
            args.Should().Contain("m1", $"{spec.AdapterId} passes the model");
            Args(spec, model: null).Should().NotContain("m1");
            spec.ProviderId.Should().Be("cli:" + spec.AdapterId);
        }
    }

    [Fact]
    public void Only_the_locally_checked_specs_are_verified() =>
        CliAgentSpecs.All.Where(s => s.Verified).Select(s => s.AdapterId).Should().Equal("claude-code", "codex", "copilot", "opencode");

    [Fact]
    public void Stdin_specs_keep_free_text_off_the_command_line()
    {
        foreach (var spec in CliAgentSpecs.All.Where(s => s.PromptInput == CliPromptInput.Stdin && !s.HasSystemPromptFlag))
        {
            Args(spec).Should().NotContain(a => a.Contains("PROMPT") || a.Contains("SYS"), spec.AdapterId);
        }
    }

    [Fact]
    public void Claude_keeps_the_tool_less_stream_flags()
    {
        var args = Args(CliAgentSpecs.ClaudeCode);

        args.Should().ContainInOrder("-p", "--output-format", "stream-json", "--tools", "", "--strict-mcp-config", "--setting-sources", "project,local");
        args.Should().ContainInOrder("--model", "m1", "--append-system-prompt", "SYS");
        args.Should().NotContain("--resume");
        CliAgentSpecs.ClaudeArguments("haiku", "s-1", "x").Should().EndWith(["--resume", "s-1"]);
    }

    [Fact]
    public void Codex_runs_read_only_without_approvals_and_reads_stdin()
    {
        var args = Args(CliAgentSpecs.Codex);

        args[0].Should().Be("exec");
        args.Should().ContainInOrder("--sandbox", "read-only").And.Contain("approval_policy=never").And.Contain("--ephemeral");
        args.Should().ContainInOrder("-C", @"C:\scratch");
        args[^1].Should().Be("-", "the prompt comes from stdin");
    }

    [Fact]
    public void Copilot_denies_shell_write_and_url_access()
    {
        var args = Args(CliAgentSpecs.Copilot);

        args.Should().ContainInOrder("-p", "PROMPT", "-s");
        args.Should().Contain(["--deny-tool=shell", "--deny-tool=write", "--deny-tool=url", "--no-ask-user", "--disable-builtin-mcps"]);
    }

    [Fact]
    public void Opencode_runs_standalone_with_every_permission_denied()
    {
        var spec = CliAgentSpecs.OpenCode;
        var args = Args(spec);

        args.Should().StartWith(["run", "--standalone"]);
        args[^1].Should().Be("PROMPT");
        args.Should().ContainInOrder("--title", CliAgentSpecs.RunTitle);
        spec.Environment["OPENCODE_CONFIG_CONTENT"].Should().Be("""{"permission":"deny"}""");
    }

    [Fact]
    public void Qwen_and_cursor_specs_follow_the_research()
    {
        Args(CliAgentSpecs.Qwen).Should().ContainInOrder("--approval-mode", "plan", "--safe-mode", "--max-tool-calls", "0");
        CliAgentSpecs.Qwen.ExitCodes[55].Should().Be("tools");
        Args(CliAgentSpecs.Cursor).Should().ContainInOrder("--mode", "ask", "--trust", "--workspace", @"C:\scratch");
        CliAgentSpecs.Cursor.Executables.Should().Equal("cursor-agent");
        CliAgentSpecs.Cursor.KnownDirOnlyExecutables.Should().Equal("agent");
        Args(CliAgentSpecs.Droid).Should().StartWith(["exec", "-o", "text"]).And.NotContain("--auto");
    }

    [Theory]
    [InlineData("You are X.", "hello", "You are X.\n\n---\n\nhello")]
    [InlineData("", "hello", "hello")]
    [InlineData(null, "--help", "Input:\n--help")]
    [InlineData("  -x", "hi", "Input:\n-x\n\n---\n\nhi")]
    public void Combined_prompts_never_look_like_a_flag(string? system, string user, string expected) =>
        CliAgentSpecs.CombinePrompt(system, user).Should().Be(expected);
}

public class AiProviderResolverTests
{
    private sealed class FakeProvider(string id, Func<AiRequest, AiResult> answer) : IAiProvider
    {
        public List<AiRequest> Requests { get; } = [];

        public string Id => id;

        public Task<AiResult> CompleteAsync(AiRequest request, CancellationToken ct)
        {
            Requests.Add(request);
            return Task.FromResult(answer(request));
        }
    }

    [Fact]
    public async Task Each_feature_runs_on_its_own_provider_and_model()
    {
        var settings = new AiSettings
        {
            Providers = [new AiProviderConfig { Name = "local", BaseUrl = "http://localhost:1" }],
            DailySummary = new AiFeatureChoice { Provider = "openai:local", Model = "qwen3" },
            DictationCleanup = new AiFeatureChoice { Provider = "cli:codex" },
        };
        var created = new Dictionary<string, FakeProvider>();
        var resolver = new AiProviderResolver(() => settings, (id, _) =>
            id is "openai:local" or "cli:codex" ? created[id] = new FakeProvider(id, r => AiResult.Ok("answer:" + r.User)) : null);
        var runs = new List<AiRunInfo>();
        resolver.Completed += runs.Add;

        var summary = await resolver.CompleteAsync(AiFeature.DailySummary, "sys", "data", TimeSpan.FromSeconds(5), CancellationToken.None);
        var cleanup = await resolver.CompleteAsync(AiFeature.DictationCleanup, "sys", "text", TimeSpan.FromSeconds(1), CancellationToken.None);

        summary.Should().Be(AiResult.Ok("answer:data", "qwen3"));
        created["openai:local"].Requests.Should().ContainSingle().Which.Should().Be(new AiRequest("sys", "data", "qwen3", TimeSpan.FromSeconds(5)));
        cleanup.Model.Should().Be("cli:codex", "without a model the provider id is what answered");
        runs.Select(r => (r.ProviderId, r.Feature, r.ErrorKind, r.InputChars, r.OutputChars))
            .Should().Equal(("openai:local", AiFeature.DailySummary, AiErrorKind.None, 7, 11), ("cli:codex", AiFeature.DictationCleanup, AiErrorKind.None, 7, 11));
    }

    [Fact]
    public async Task An_unknown_provider_is_not_configured()
    {
        var resolver = new AiProviderResolver(() => new AiSettings { Assistant = new AiFeatureChoice { Provider = "openai:gone" } }, (_, _) => null);

        var result = await resolver.CompleteAsync(AiFeature.Assistant, "s", "u", TimeSpan.FromSeconds(1), CancellationToken.None);

        result.ErrorKind.Should().Be(AiErrorKind.NotConfigured);
        result.IsOk.Should().BeFalse();
    }
}
