using System.Text.Json.Nodes;
using Hub.Core.Adapters;
using Hub.Infrastructure.Gemini;
using Hub.Infrastructure.Qwen;

namespace Hub.Infrastructure.Tests;

/// <summary>Gemini CLI and Qwen Code hook installers on temp copies of <c>adapters/{gemini,qwen}/fixtures/settings.jsonc</c>.</summary>
public sealed class GeminiQwenHooksTests : IDisposable
{
    private const string HookExe = @"C:\Users\u\AppData\Local\agent-hub\hub\bin\agenthub-hook.exe";
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    internal static string Fixture(string agent, string file)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "adapters")))
        {
            dir = dir.Parent;
        }

        return Path.Combine(dir!.FullName, "adapters", agent, "fixtures", file);
    }

    private string Settings(string agent)
    {
        var path = Path.Combine(_dir.Path, agent, "settings.json");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.Copy(Fixture(agent, "settings.jsonc"), path);
        return path;
    }

    private static JsonObject Read(string path) =>
        (JsonObject)JsonNode.Parse(File.ReadAllText(path), documentOptions: new() { CommentHandling = System.Text.Json.JsonCommentHandling.Skip, AllowTrailingCommas = true })!;

    private static List<JsonObject> Handlers(JsonObject root, string eventName) =>
        ((JsonArray)root["hooks"]![eventName]!).OfType<JsonObject>().SelectMany(g => ((JsonArray)g["hooks"]!).OfType<JsonObject>()).ToList();

    [Fact]
    public void Gemini_install_writes_powershell_commands_with_ms_timeouts_and_keeps_the_users_hooks()
    {
        var path = Settings("gemini");
        var installer = new GeminiHooksInstaller(path, HookExe);
        installer.GetStatus().State.Should().Be(HookInstallState.Missing);
        installer.GetStatus().Hint.Should().BeNull("nothing to explain before the install");

        installer.Install().Should().NotBeNull("the JSONC file is backed up first");

        var root = Read(path);
        root["general"]!["vimMode"]!.GetValue<bool>().Should().BeFalse();
        foreach (var spec in GeminiHooksInstaller.Events)
        {
            var own = Handlers(root, spec.Event).Where(h => h["command"]!.GetValue<string>().Contains("agenthub-hook")).Should().ContainSingle().Subject;
            own["command"]!.GetValue<string>().Should().Be(OsForm.Pick($"& '{HookExe}' --agent gemini --event {spec.Event}", $"'{HookExe}' --agent gemini --event {spec.Event}"));
            own["timeout"]!.GetValue<int>().Should().Be(5000, "Gemini timeouts are milliseconds");
            own["type"]!.GetValue<string>().Should().Be("command");
        }

        Handlers(root, "BeforeTool").Select(h => h["command"]!.GetValue<string>()).Should().Contain("node C:/tools/lint-hook.js");
        ((JsonArray)root["hooks"]!["BeforeTool"]!).OfType<JsonObject>().Last()["matcher"]!.GetValue<string>().Should().Be("*");
        ((JsonObject)root["hooks"]!).Select(kv => kv.Key).Should().NotContain(["BeforeModel", "AfterModel", "BeforeToolSelection"]);

        var status = installer.GetStatus();
        status.State.Should().Be(HookInstallState.Installed);
        status.Hint.Should().Be(HookHints.FolderTrust);
        installer.Install().Should().BeNull("already installed");
        installer.ReferencedHookExes().Should().Equal(HookExe);

        installer.Uninstall().Should().NotBeNull();
        var after = Read(path);
        Handlers(after, "BeforeTool").Should().ContainSingle().Which["command"]!.GetValue<string>().Should().Be("node C:/tools/lint-hook.js");
        ((JsonObject)after["hooks"]!).Select(kv => kv.Key).Should().Equal("BeforeTool");
    }

    [Theory]
    [InlineData("""{ "security": { "folderTrust": { "enabled": false } } }""", null)]
    [InlineData("""{ "security": { "folderTrust": { "enabled": true } } }""", HookHints.FolderTrust)]
    [InlineData("""{ "security": [] }""", HookHints.FolderTrust)]
    [InlineData("""{ "hooksConfig": { "enabled": false } }""", HookHints.HooksDisabled)]
    public void Gemini_hint_follows_the_trust_and_hook_settings(string settings, string? hint)
    {
        var path = _dir.File("gemini-settings.json");
        File.WriteAllText(path, settings);
        var installer = new GeminiHooksInstaller(path, HookExe);
        installer.Install();

        installer.GetStatus().Hint.Should().Be(hint);
    }

    [Fact]
    public void Gemini_command_quotes_a_path_with_spaces_and_apostrophes_for_powershell()
    {
        var installer = new GeminiHooksInstaller(_dir.File("s.json"), @"C:\Program Files\it's\agenthub-hook.exe");

        installer.CommandFor("AfterAgent").Should().Be(OsForm.Pick(
            @"& 'C:\Program Files\it''s\agenthub-hook.exe' --agent gemini --event AfterAgent",
            @"'C:\Program Files\it'\''s\agenthub-hook.exe' --agent gemini --event AfterAgent"));
        HookCommand.ExePath(installer.CommandFor("AfterAgent")).Should().Be(@"C:\Program Files\it's\agenthub-hook.exe");
    }

    [Fact]
    public void Invalid_settings_are_reported_and_never_rewritten()
    {
        foreach (var (agent, installer) in new (string, IHookInstaller)[]
                 {
                     ("gemini", new GeminiHooksInstaller(_dir.File("g.json"), HookExe)),
                     ("qwen", new QwenHooksInstaller(_dir.File("q.json"), HookExe)),
                 })
        {
            File.WriteAllText(installer.ConfigPath, "{ \"hooks\": ");
            installer.GetStatus().State.Should().Be(HookInstallState.InvalidConfig, agent);
            installer.Invoking(i => i.Install()).Should().Throw<HookConfigException>();
            File.ReadAllText(installer.ConfigPath).Should().Be("{ \"hooks\": ");
        }
    }

    [Fact]
    public void Qwen_install_writes_unquoted_cmd_commands_in_seconds_and_no_permission_request()
    {
        var path = Settings("qwen");
        var installer = new QwenHooksInstaller(path, HookExe);

        installer.Install().Should().NotBeNull();

        var root = Read(path);
        root["model"]!["name"]!.GetValue<string>().Should().Be("qwen3-coder-plus");
        foreach (var spec in QwenHooksInstaller.Events)
        {
            var own = Handlers(root, spec.Event).Where(h => h["command"]!.GetValue<string>().Contains("agenthub-hook")).Should().ContainSingle().Subject;
            own["command"]!.GetValue<string>().Should().Be(
                OsForm.Pick($"{HookExe} --agent qwen --event {spec.Event}", $"'{HookExe}' --agent qwen --event {spec.Event}"),
                "cmd without verbatim arguments breaks on quotes");
            own["timeout"]!.GetValue<int>().Should().Be(5);
        }

        ((JsonObject)root["hooks"]!).Select(kv => kv.Key).Should().NotContain(["PermissionRequest", "MessageDisplay"]);
        Handlers(root, "Stop").Select(h => h["command"]!.GetValue<string>()).Should().Contain(@"C:\tools\notify.exe");
        installer.CommandRunsOnWindows.Should().BeTrue();

        var status = installer.GetStatus();
        status.State.Should().Be(HookInstallState.Installed);
        status.Hint.Should().BeNull();

        installer.Uninstall();
        Handlers(Read(path), "Stop").Should().ContainSingle();
    }

    [Fact]
    public void Qwen_reports_hooks_switched_off_by_its_own_setting()
    {
        var path = _dir.File("qwen-settings.json");
        File.WriteAllText(path, """{ "disableAllHooks": true }""");
        var installer = new QwenHooksInstaller(path, HookExe);
        installer.Install();

        installer.GetStatus().Hint.Should().Be(HookHints.HooksDisabled);
    }
}
