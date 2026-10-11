using System.Text.Json.Nodes;
using Hub.Core.Adapters;
using Hub.Infrastructure.Codex;

namespace Hub.Infrastructure.Tests;

public sealed class CodexHooksMergerTests : IDisposable
{
    private const string HookExe = @"C:\Users\u\AppData\Local\agent-hub\hub\bin\agenthub-hook.exe";
    private readonly TempDir _dir = new();
    private readonly string _hooks;
    private readonly string _config;

    public CodexHooksMergerTests()
    {
        _hooks = _dir.File("hooks.json");
        _config = _dir.File("config.toml");
    }

    public void Dispose() => _dir.Dispose();

    private CodexHooksMerger Merger(string exe = HookExe) => new(_hooks, _config, exe);

    private JsonObject Read() => (JsonObject)JsonNode.Parse(File.ReadAllText(_hooks))!;

    private static IEnumerable<JsonObject> Handlers(JsonObject root, string eventName) =>
        ((JsonArray)root["hooks"]![eventName]!).OfType<JsonObject>().SelectMany(g => ((JsonArray)g["hooks"]!).OfType<JsonObject>());

    [Fact]
    public void Install_writes_every_event_with_command_and_command_windows()
    {
        Merger().GetStatus().State.Should().Be(HookInstallState.Missing);

        Merger().Install().Should().BeNull("there was no file to back up");

        var root = Read();
        foreach (var (eventName, timeout) in CodexHooksMerger.Events)
        {
            var handler = Handlers(root, eventName).Should().ContainSingle().Subject;
            // Unquoted: Codex's `cmd /C "<command>"` wrapper does not run commands containing quotes (D-013).
            var expected = $"{HookExe} --agent codex --event {eventName}";
            handler["type"]!.GetValue<string>().Should().Be("command");
            handler["command"]!.GetValue<string>().Should().Be(expected);
            handler["commandWindows"]!.GetValue<string>().Should().Be(expected);
            handler["timeout"]!.GetValue<int>().Should().Be(timeout);
        }

        Handlers(root, "SessionEnd").Single()["timeout"]!.GetValue<int>().Should().BeLessThanOrEqualTo(3);
        Merger().GetStatus().State.Should().Be(HookInstallState.Installed);
    }

    [Fact]
    public void Existing_hooks_are_kept_backed_up_and_uninstall_restores_them()
    {
        File.WriteAllText(_hooks, """
            { "description": "mine", "hooks": { "Stop": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "notify.ps1" } ] } ] } }
            """);

        var backup = Merger().Install();

        backup.Should().NotBeNull();
        File.ReadAllText(backup!).Should().Contain("notify.ps1");
        var root = Read();
        root["description"]!.GetValue<string>().Should().Be("mine");
        Handlers(root, "Stop").Select(h => h["command"]!.GetValue<string>()).Should().HaveCount(2).And.Contain("notify.ps1");

        Merger().Uninstall().Should().NotBeNull();
        root = Read();
        Handlers(root, "Stop").Should().ContainSingle().Which["command"]!.GetValue<string>().Should().Be("notify.ps1");
        ((JsonObject)root["hooks"]!).Select(kv => kv.Key).Should().Equal("Stop");
        Merger().GetStatus().State.Should().Be(HookInstallState.Missing);
    }

    [Fact]
    public void Install_is_idempotent_and_a_moved_exe_is_outdated()
    {
        Merger(@"C:\old\agenthub-hook.exe").Install();
        Merger().GetStatus().State.Should().Be(HookInstallState.Outdated);

        Merger().Install();
        var first = File.ReadAllText(_hooks);
        Merger().Install().Should().BeNull();

        File.ReadAllText(_hooks).Should().Be(first);
        Handlers(Read(), "Stop").Should().ContainSingle();
    }

    [Theory]
    [InlineData("{ not json", true)]
    [InlineData("""{ "hooks": [] }""", false)]
    [InlineData("{ // comment\n \"hooks\": {} }", true)]
    public void Unreadable_or_unexpected_files_are_never_rewritten(string content, bool unparseable)
    {
        File.WriteAllText(_hooks, content);

        var act = () => Merger().Install();

        act.Should().Throw<HookConfigException>();
        if (unparseable)
        {
            Merger().GetStatus().State.Should().Be(HookInstallState.InvalidConfig);
        }

        File.ReadAllText(_hooks).Should().Be(content);
    }

    [Fact]
    public void Installed_hooks_need_approval_until_config_toml_trusts_each_one()
    {
        Merger().Install();
        Merger().GetStatus().NeedsApproval.Should().BeTrue("Codex skips hooks the user has not trusted");

        var path = Path.GetFullPath(_hooks);
        var lines = CodexHooksMerger.Events
            .Select(e => $"[hooks.state.\"{path.Replace(@"\", @"\\", StringComparison.Ordinal)}:{e.Event}:0:0\"]\ntrusted_hash = \"sha256:abc\"\n")
            .ToList();
        File.WriteAllText(_config, "model = \"x\"\n\n" + string.Join("\n", lines.Skip(1)));
        Merger().GetStatus().NeedsApproval.Should().BeTrue("one event is still untrusted");

        File.WriteAllText(_config, "model = \"x\"\n\n" + string.Join("\n", lines));
        Merger().GetStatus().NeedsApproval.Should().BeFalse();
    }

    [Fact]
    public void Trust_scanner_reads_literal_keys_and_inline_tables()
    {
        File.WriteAllText(_config, """
            [hooks.state.'C:\x\hooks.json:Stop:0:0']
            trusted_hash = "sha256:1"

            [hooks.state]
            "C:\\x\\hooks.json:Interrupt:1:0" = { trusted_hash = "sha256:2" }
            "C:\\x\\hooks.json:SessionEnd:0:0" = { enabled = false }

            [other]
            trusted_hash = "ignored"
            """);

        CodexTrustScanner.TrustedKeys(_config).Should().BeEquivalentTo(
            [@"C:\x\hooks.json:Stop:0:0", @"C:\x\hooks.json:Interrupt:1:0"]);
    }
}
