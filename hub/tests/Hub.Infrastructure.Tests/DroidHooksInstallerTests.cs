using System.Text.Json.Nodes;
using Hub.Core.Adapters;
using Hub.Infrastructure.Droid;

namespace Hub.Infrastructure.Tests;

/// <summary>
/// Droid's <c>hooks.json</c> vs <c>settings.json</c> choice: never create <c>hooks.json</c> over hooks the user keeps in
/// <c>settings.json</c>. Always in a temp folder, never the real <c>~/.factory</c>.
/// </summary>
public sealed class DroidHooksInstallerTests : IDisposable
{
    private const string HookExe = @"C:\Users\u\AppData\Local\agent-hub\hub\bin\agenthub-hook.exe";
    private const string UserHook = """{ "type": "command", "command": "C:/tools/lint.cmd", "timeout": 30 }""";
    private readonly TempDir _dir = new();
    private readonly DroidHooksInstaller _installer;

    public DroidHooksInstallerTests()
    {
        _installer = new DroidHooksInstaller(_dir.Path, HookExe);
    }

    public void Dispose() => _dir.Dispose();

    private string HooksJson => _dir.File("hooks.json");

    private string Settings => _dir.File("settings.json");

    private static JsonObject Read(string path) => (JsonObject)JsonNode.Parse(File.ReadAllText(path))!;

    [Fact]
    public void Without_any_file_the_hooks_go_into_a_new_hooks_json_with_top_level_events()
    {
        _installer.GetStatus().Should().Be(new HookStatus(HookInstallState.Missing, HooksJson));

        _installer.Install().Should().BeNull("there was no file to back up");

        File.Exists(Settings).Should().BeFalse();
        var root = Read(HooksJson);
        root.Select(kv => kv.Key).Should().BeEquivalentTo(DroidHooksInstaller.Events.Select(e => e.Event));
        root.ContainsKey("hooks").Should().BeFalse("hooks.json is keyed by event directly");
        var pre = (JsonObject)root["PreToolUse"]![0]!;
        pre["matcher"]!.GetValue<string>().Should().Be("*");
        var handler = (JsonObject)pre["hooks"]![0]!;
        handler["type"]!.GetValue<string>().Should().Be("command");
        handler["command"]!.GetValue<string>().Should().Be($"\"{HookExe}\" --agent droid --event PreToolUse");
        handler["timeout"]!.GetValue<int>().Should().Be(10);
        ((JsonObject)root["Stop"]![0]!).ContainsKey("matcher").Should().BeFalse();
        _installer.GetStatus().Should().Be(new HookStatus(HookInstallState.Installed, HooksJson));
    }

    [Fact]
    public void Hooks_kept_in_settings_json_get_ours_next_to_them_and_no_hooks_json_is_created()
    {
        File.WriteAllText(Settings, $$"""{ "model": "x", "hooks": { "PostToolUse": [ { "matcher": "Edit", "hooks": [ {{UserHook}} ] } ] } }""");

        _installer.ConfigPath.Should().Be(Settings);
        _installer.Install().Should().NotBeNull("settings.json is backed up first");

        File.Exists(HooksJson).Should().BeFalse("it would hide the user's settings.json hooks");
        var root = Read(Settings);
        root["model"]!.GetValue<string>().Should().Be("x");
        var post = (JsonArray)root["hooks"]!["PostToolUse"]!;
        post.Should().HaveCount(2);
        post[0]!["hooks"]![0]!["command"]!.GetValue<string>().Should().Be("C:/tools/lint.cmd");
        _installer.GetStatus().Should().Be(new HookStatus(HookInstallState.Installed, Settings));

        _installer.Uninstall().Should().NotBeNull();

        root = Read(Settings);
        ((JsonArray)root["hooks"]!["PostToolUse"]!).Should().ContainSingle();
        ((JsonObject)root["hooks"]!).Should().ContainSingle("only the user's event is left");
        _installer.GetStatus().Should().Be(new HookStatus(HookInstallState.Missing, Settings));
    }

    [Fact]
    public void An_existing_hooks_json_wins_and_settings_json_is_left_alone()
    {
        File.WriteAllText(HooksJson, $$"""{ "Stop": [ { "hooks": [ {{UserHook}} ] } ] }""");
        var settings = $$"""{ "hooks": { "Stop": [ { "hooks": [ {{UserHook}} ] } ] } }""";
        File.WriteAllText(Settings, settings);

        _installer.Install();

        File.ReadAllText(Settings).Should().Be(settings);
        var stop = (JsonArray)Read(HooksJson)["Stop"]!;
        stop.Should().HaveCount(2);
        stop[0]!["hooks"]![0]!["command"]!.GetValue<string>().Should().Be("C:/tools/lint.cmd");
        _installer.GetStatus().Should().Be(new HookStatus(HookInstallState.Installed, HooksJson));
    }

    [Theory]
    [InlineData("""{ "hooks": {} }""")]
    [InlineData("""{ "theme": "dark" }""")]
    [InlineData("""{ "hooks": null }""")]
    public void Settings_json_without_hooks_does_not_take_them(string settings)
    {
        File.WriteAllText(Settings, settings);

        _installer.Install();

        File.ReadAllText(Settings).Should().Be(settings);
        Read(HooksJson).Should().ContainKey("SessionStart");
    }

    [Fact]
    public void Settings_json_with_comments_is_still_read_for_the_decision()
    {
        var settings = "{\n  // user's hooks\n  \"hooks\": { \"Stop\": [ { \"hooks\": [ " + UserHook + " ] } ] }\n}";
        File.WriteAllText(Settings, settings);

        _installer.GetStatus().Should().Be(new HookStatus(HookInstallState.InvalidConfig, Settings), "writes stay strict JSON");
        var install = () => _installer.Install();
        install.Should().Throw<HookConfigException>();

        File.Exists(HooksJson).Should().BeFalse();
        File.ReadAllText(Settings).Should().Be(settings);
    }

    [Fact]
    public void Unreadable_settings_json_is_never_rewritten_nor_hidden_by_a_new_hooks_json()
    {
        File.WriteAllText(Settings, "{ not json");

        _installer.GetStatus().Should().Be(new HookStatus(HookInstallState.InvalidConfig, Settings));
        var install = () => _installer.Install();
        install.Should().Throw<HookConfigException>();
        File.Exists(HooksJson).Should().BeFalse();
        File.ReadAllText(Settings).Should().Be("{ not json");
    }

    [Fact]
    public void Leftovers_in_the_unused_file_show_as_outdated_and_install_removes_them()
    {
        File.WriteAllText(Settings, $$"""{ "hooks": { "Stop": [ { "hooks": [ {{UserHook}} ] } ] } }""");
        _installer.Install();
        Read(Settings)["hooks"]!["SessionStart"].Should().NotBeNull();

        // The user moves to hooks.json later; Droid now ignores settings.json hooks.
        File.WriteAllText(HooksJson, "{}");
        _installer.GetStatus().State.Should().Be(HookInstallState.Missing);
        _installer.Install();
        _installer.GetStatus().Should().Be(new HookStatus(HookInstallState.Installed, HooksJson));

        var settings = Read(Settings);
        ((JsonObject)settings["hooks"]!).Select(kv => kv.Key).Should().Equal("Stop");
        _installer.ReferencedHookExes().Should().Equal(HookExe);

        // A leftover next to a complete install reads as outdated.
        File.WriteAllText(Settings, $$"""{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "\"{{HookExe.Replace(@"\", @"\\", StringComparison.Ordinal)}}\" --agent droid --event Stop" } ] } ] } }""");
        _installer.GetStatus().Should().Be(new HookStatus(HookInstallState.Outdated, HooksJson));
    }

    [Fact]
    public void Uninstall_removes_our_entries_from_both_files()
    {
        File.WriteAllText(HooksJson, $$"""{ "Stop": [ { "hooks": [ {{UserHook}} ] } ] }""");
        _installer.Install();
        var ours = $$"""{ "type": "command", "command": "\"{{HookExe.Replace(@"\", @"\\", StringComparison.Ordinal)}}\" --agent droid --event Stop" }""";
        File.WriteAllText(Settings, $$"""{ "hooks": { "Stop": [ { "hooks": [ {{ours}} ] } ] }, "model": "m" }""");

        _installer.Uninstall().Should().NotBeNull();

        Read(HooksJson).Select(kv => kv.Key).Should().Equal("Stop");
        var settings = Read(Settings);
        settings.ContainsKey("hooks").Should().BeFalse();
        settings["model"]!.GetValue<string>().Should().Be("m");
        _installer.Uninstall().Should().BeNull("nothing left to remove");
    }

    [Fact]
    public void Hooks_disabled_in_settings_json_is_reported_as_a_hint()
    {
        _installer.Install();
        _installer.GetStatus().Hint.Should().BeNull();

        File.WriteAllText(Settings, """{ "hooksDisabled": true }""");

        _installer.GetStatus().Should().Be(new HookStatus(HookInstallState.Installed, HooksJson) { Hint = HookHints.HooksDisabled });
    }

    [Fact]
    public void Uninstall_without_files_creates_nothing()
    {
        _installer.Uninstall().Should().BeNull();

        File.Exists(HooksJson).Should().BeFalse();
        File.Exists(Settings).Should().BeFalse();
    }
}
