using System.Text.Json.Nodes;
using Hub.Core.Adapters;
using Hub.Infrastructure.Claude;

namespace Hub.Infrastructure.Tests;

public sealed class ClaudeSettingsMergerTests : IDisposable
{
    private const string HookExe = @"C:\Program Files\agent-hub\agenthub-hook.exe";
    private readonly TempDir _dir = new();
    private readonly string _settings;

    public ClaudeSettingsMergerTests() => _settings = _dir.File("settings.json");

    public void Dispose() => _dir.Dispose();

    private ClaudeSettingsMerger Merger(string exe = HookExe) => new(_settings, exe);

    private JsonObject ReadSettings() => (JsonObject)JsonNode.Parse(File.ReadAllText(_settings))!;

    private static IEnumerable<JsonObject> Handlers(JsonObject root, string eventName) =>
        ((JsonArray)root["hooks"]![eventName]!).OfType<JsonObject>()
            .SelectMany(g => ((JsonArray)g["hooks"]!).OfType<JsonObject>());

    [Fact]
    public void Missing_file_is_created_with_all_events()
    {
        Merger().GetState().Should().Be(HookInstallState.Missing);

        var backup = Merger().Install();

        backup.Should().BeNull("there was nothing to back up");
        var root = ReadSettings();
        foreach (var (eventName, _) in ClaudeSettingsMerger.Events)
        {
            Handlers(root, eventName).Should().ContainSingle()
                .Which["command"]!.GetValue<string>().Should().Be($"\"{HookExe}\" --agent claude-code --event {eventName}");
        }

        Merger().GetState().Should().Be(HookInstallState.Installed);
    }

    [Fact]
    public void Matcher_is_empty_string_and_omitted_for_events_without_matcher()
    {
        Merger().Install();
        var root = ReadSettings();

        var preToolGroup = (JsonObject)((JsonArray)root["hooks"]!["PreToolUse"]!)[0]!;
        preToolGroup["matcher"]!.GetValue<string>().Should().BeEmpty();

        var stopGroup = (JsonObject)((JsonArray)root["hooks"]!["Stop"]!)[0]!;
        stopGroup.ContainsKey("matcher").Should().BeFalse();
        var promptGroup = (JsonObject)((JsonArray)root["hooks"]!["UserPromptSubmit"]!)[0]!;
        promptGroup.ContainsKey("matcher").Should().BeFalse();
    }

    [Fact]
    public void Empty_file_is_treated_as_empty_object()
    {
        File.WriteAllText(_settings, "  ");
        Merger().Install();
        Merger().GetState().Should().Be(HookInstallState.Installed);
    }

    [Fact]
    public void Existing_settings_and_hooks_are_preserved_and_backup_is_written()
    {
        File.WriteAllText(_settings, """
            {
              // user comment
              "theme": "dark",
              "hooks": {
                "PreToolUse": [
                  { "matcher": "Bash", "hooks": [ { "type": "command", "command": "my-guard.sh" } ] }
                ],
                "PreCompact": [
                  { "matcher": "", "hooks": [ { "type": "command", "command": "notify.ps1" } ] }
                ]
              },
            }
            """);

        var backup = Merger().Install();

        backup.Should().NotBeNull();
        File.Exists(backup).Should().BeTrue();
        File.ReadAllText(backup!).Should().Contain("my-guard.sh");

        var root = ReadSettings();
        root["theme"]!.GetValue<string>().Should().Be("dark");
        Handlers(root, "PreToolUse").Select(h => h["command"]!.GetValue<string>())
            .Should().Equal("my-guard.sh", $"\"{HookExe}\" --agent claude-code --event PreToolUse");
        Handlers(root, "PreCompact").Should().ContainSingle();
    }

    [Fact]
    public void Install_is_idempotent()
    {
        Merger().Install();
        var first = File.ReadAllText(_settings);

        Merger().Install().Should().BeNull("already installed");

        File.ReadAllText(_settings).Should().Be(first);
        Handlers(ReadSettings(), "Stop").Should().ContainSingle();
    }

    [Fact]
    public void Different_exe_path_is_outdated_and_install_repairs_it()
    {
        Merger(@"C:\old\agenthub-hook.exe").Install();

        Merger().GetState().Should().Be(HookInstallState.Outdated);
        Merger().Install();

        Merger().GetState().Should().Be(HookInstallState.Installed);
        Handlers(ReadSettings(), "Stop").Should().ContainSingle()
            .Which["command"]!.GetValue<string>().Should().Contain(@"C:\Program Files\agent-hub");
    }

    [Fact]
    public void Missing_event_is_outdated()
    {
        Merger().Install();
        var root = ReadSettings();
        ((JsonObject)root["hooks"]!).Remove("SessionEnd");
        File.WriteAllText(_settings, root.ToJsonString());

        Merger().GetState().Should().Be(HookInstallState.Outdated);
    }

    [Fact]
    public void Uninstall_removes_only_own_entries()
    {
        File.WriteAllText(_settings, """
            { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "my-guard.sh" } ] } ] } }
            """);
        Merger().Install();

        Merger().Uninstall().Should().NotBeNull();

        var root = ReadSettings();
        var hooks = (JsonObject)root["hooks"]!;
        hooks.Select(kv => kv.Key).Should().Equal("PreToolUse");
        Handlers(root, "PreToolUse").Should().ContainSingle().Which["command"]!.GetValue<string>().Should().Be("my-guard.sh");
        Merger().GetState().Should().Be(HookInstallState.Missing);
    }

    [Fact]
    public void Uninstall_drops_empty_hooks_object()
    {
        File.WriteAllText(_settings, """{ "model": "opus" }""");
        Merger().Install();
        Merger().Uninstall();

        var root = ReadSettings();
        root.ContainsKey("hooks").Should().BeFalse();
        root["model"]!.GetValue<string>().Should().Be("opus");
    }

    [Fact]
    public void Uninstall_without_own_entries_does_nothing()
    {
        File.WriteAllText(_settings, """{ "model": "opus" }""");
        Merger().Uninstall().Should().BeNull();
        File.ReadAllText(_settings).Should().Be("""{ "model": "opus" }""");
    }

    [Fact]
    public void Bare_exe_command_from_an_older_build_is_outdated_and_its_path_is_reported()
    {
        File.WriteAllText(_settings, """
            { "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "\"C:\\old\\agenthub-hook.exe\"" } ] } ] } }
            """);

        Merger().GetState().Should().Be(HookInstallState.Outdated);
        Merger().ReferencedHookExes().Should().Equal(@"C:\old\agenthub-hook.exe");
    }

    [Fact]
    public void Invalid_json_is_never_overwritten()
    {
        File.WriteAllText(_settings, "{ not json");

        var act = () => Merger().Install();

        act.Should().Throw<HookConfigException>();
        Merger().GetStatus().State.Should().Be(HookInstallState.InvalidConfig);
        File.ReadAllText(_settings).Should().Be("{ not json");
    }

    [Fact]
    public void Hooks_with_wrong_shape_are_never_overwritten()
    {
        File.WriteAllText(_settings, """{ "hooks": [] }""");

        var act = () => Merger().Install();

        act.Should().Throw<HookConfigException>();
        File.ReadAllText(_settings).Should().Be("""{ "hooks": [] }""");
    }
}
