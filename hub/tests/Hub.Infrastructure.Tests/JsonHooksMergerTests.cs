using System.Text.Json.Nodes;
using Hub.Core.Adapters;
using Hub.Infrastructure.Hooks;
using Hub.Infrastructure.Platform;

namespace Hub.Infrastructure.Tests;

/// <summary>
/// <see cref="JsonHooksMerger"/> for the shapes wave-2 agents need (Gemini/Qwen/Droid matcher groups, Cursor flat entries,
/// Copilot's own file), always in a temp folder. Claude and Codex are covered by their own merger tests.
/// </summary>
public sealed class JsonHooksMergerTests : IDisposable
{
    private const string HookExe = @"C:\Users\u\AppData\Local\agent-hub\hub\bin\agenthub-hook.exe";
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private static JsonObject Read(string path) => (JsonObject)JsonNode.Parse(File.ReadAllText(path))!;

    private static JsonHooksMerger Gemini(string path) => new(
        new JsonHooksOptions(path, "gemini", [new("SessionStart", Matcher: "*"), new("BeforeTool", Matcher: "*"), new("AfterAgent")], HookEntryShape.MatcherGroups, HookShell.PowerShell)
        {
            DefaultTimeout = 5000,
            AllowComments = true,
            Description = "Gemini CLI settings",
        },
        HookExe);

    [Fact]
    public void Entries_under_a_legacy_marker_are_ours_after_a_rename()
    {
        const string NewExe = @"C:\Users\u\AppData\Local\new-name\hub\bin\newname-hook.exe";
        var path = _dir.File("hooks.json");
        File.WriteAllText(path, """
            { "stop": [
              { "command": "C:/Users/u/AppData/Local/old-name/hub/bin/oldname-hook.exe --agent cursor --event stop" },
              { "command": "C:/tools/othername-hook.exe --event stop" },
              { "command": "./audit.sh" }
            ] }
            """);
        JsonHooksMerger Cursor() => new(
            new JsonHooksOptions(path, "cursor", [new("stop")], HookEntryShape.FlatCommands, HookShell.Any)
            {
                HooksKey = null,
                OwnedMarkers = ["newname-hook", "oldname-hook"],
            },
            NewExe);

        Cursor().GetStatus().State.Should().Be(HookInstallState.Outdated, "the legacy entry is ours but points at the old exe");
        Cursor().Install().Should().NotBeNull();

        var commands = ((JsonArray)Read(path)["stop"]!).Select(e => e!["command"]!.GetValue<string>()).ToList();
        commands.Should().HaveCount(3);
        commands.Should().NotContain(c => c.Contains("oldname-hook", StringComparison.Ordinal), "repair rewrites it to the current exe");
        commands.Should().Contain("C:/tools/othername-hook.exe --event stop", "an unknown marker is not ours");
        commands.Should().Contain("./audit.sh");
        Cursor().GetStatus().State.Should().Be(HookInstallState.Installed);

        Cursor().Uninstall();
        ((JsonArray)Read(path)["stop"]!).Select(e => e!["command"]!.GetValue<string>())
            .Should().Equal("C:/tools/othername-hook.exe --event stop", "./audit.sh");
    }

    [Fact]
    public void Matcher_groups_in_a_jsonc_file_keep_user_entries_and_use_the_powershell_form()
    {
        var path = _dir.File("settings.json");
        File.WriteAllText(path, """
            {
              // Gemini settings are JSONC
              "theme": "dark",
              "hooks": { "BeforeTool": [ { "matcher": "run_shell_command", "hooks": [ { "type": "command", "command": "guard.ps1" } ] } ] },
            }
            """);

        var backup = Gemini(path).Install();

        backup.Should().NotBeNull();
        File.ReadAllText(backup!).Should().Contain("// Gemini settings are JSONC", "the backup is the untouched original");
        var root = Read(path);
        root["theme"]!.GetValue<string>().Should().Be("dark");
        var groups = (JsonArray)root["hooks"]!["BeforeTool"]!;
        groups.Should().HaveCount(2);
        var ours = (JsonObject)groups[1]!;
        ours["matcher"]!.GetValue<string>().Should().Be("*");
        var handler = (JsonObject)((JsonArray)ours["hooks"]!)[0]!;
        handler["command"]!.GetValue<string>().Should().Be(OsForm.Pick($"& '{HookExe}' --agent gemini --event BeforeTool", $"'{HookExe}' --agent gemini --event BeforeTool"));
        handler["timeout"]!.GetValue<int>().Should().Be(5000);
        ((JsonObject)((JsonArray)root["hooks"]!["AfterAgent"]!)[0]!).ContainsKey("matcher").Should().BeFalse();
        Gemini(path).GetStatus().State.Should().Be(HookInstallState.Installed);
        Gemini(path).ReferencedHookExes().Should().Equal(HookExe);

        Gemini(path).Uninstall().Should().NotBeNull();
        root = Read(path);
        ((JsonObject)root["hooks"]!).Select(kv => kv.Key).Should().Equal("BeforeTool");
        Gemini(path).GetStatus().State.Should().Be(HookInstallState.Missing);
    }

    [Fact]
    public void Cursor_flat_entries_get_a_version_and_the_shell_neutral_form()
    {
        var path = _dir.File("hooks.json");
        var merger = new JsonHooksMerger(
            new JsonHooksOptions(path, "cursor", [new("sessionStart"), new("stop")], HookEntryShape.FlatCommands, HookShell.Any) { FileVersion = 1 },
            HookExe);

        merger.Install().Should().BeNull("there was no file");

        var root = Read(path);
        root.Select(kv => kv.Key).Should().Equal("version", "hooks");
        root["version"]!.GetValue<int>().Should().Be(1);
        var entry = (JsonObject)((JsonArray)root["hooks"]!["stop"]!).Single()!;
        entry["command"]!.GetValue<string>().Should().Be(OsForm.Pick(
            "C:/Users/u/AppData/Local/agent-hub/hub/bin/agenthub-hook.exe --agent cursor --event stop", $"'{HookExe}' --agent cursor --event stop"));
        entry["timeout"]!.GetValue<int>().Should().Be(5);
        entry.ContainsKey("type").Should().BeFalse();
        merger.GetStatus().State.Should().Be(HookInstallState.Installed);
        merger.ReferencedHookExes().Should().Equal(OsForm.Pick("C:/Users/u/AppData/Local/agent-hub/hub/bin/agenthub-hook.exe", HookExe));

        merger.Uninstall();
        Read(path).Select(kv => kv.Key).Should().Equal("version");
    }

    [Fact]
    public void Cursor_keeps_an_existing_version_and_other_hooks()
    {
        var path = _dir.File("hooks.json");
        File.WriteAllText(path, """{ "version": 1, "hooks": { "stop": [ { "command": "./audit.sh" } ] } }""");
        var merger = new JsonHooksMerger(
            new JsonHooksOptions(path, "cursor", [new("stop")], HookEntryShape.FlatCommands, HookShell.Any) { FileVersion = 1 }, HookExe);

        merger.Install();
        merger.Uninstall();

        Read(path).ToJsonString().Should().Be("""{"version":1,"hooks":{"stop":[{"command":"./audit.sh"}]}}""");
    }

    [Fact]
    public void Copilot_own_file_is_created_and_deleted_again()
    {
        var path = Path.Combine(_dir.Path, "hooks", "agenthub.json");
        var merger = new JsonHooksMerger(
            new JsonHooksOptions(path, "copilot", [new("sessionStart"), new("agentStop", Timeout: 10)], HookEntryShape.CopilotCommands, HookShell.PowerShell)
            {
                FileVersion = 1,
                OwnFile = true,
            },
            HookExe);

        merger.Install();

        var entry = (JsonObject)((JsonArray)Read(path)["hooks"]!["agentStop"]!).Single()!;
        entry["type"]!.GetValue<string>().Should().Be("command");
        entry["powershell"]!.GetValue<string>().Should().Be($"& '{HookExe}' --agent copilot --event agentStop");
        entry["bash"]!.GetValue<string>().Should().Be($"'{HookExe}' --agent copilot --event agentStop");
        entry["timeoutSec"]!.GetValue<int>().Should().Be(10);
        merger.GetStatus().State.Should().Be(HookInstallState.Installed);

        var backup = merger.Uninstall();

        File.Exists(path).Should().BeFalse("the file was ours alone");
        backup.Should().NotBeNull();
        File.ReadAllText(backup!).Should().Contain("agentStop");
        merger.GetStatus().State.Should().Be(HookInstallState.Missing);
    }

    [Fact]
    public void Droid_hooks_json_keeps_events_at_the_top_level()
    {
        var path = _dir.File("hooks.json");
        File.WriteAllText(path, """{ "PreToolUse": [ { "matcher": "Execute", "hooks": [ { "type": "command", "command": "lint.cmd" } ] } ] }""");
        var merger = new JsonHooksMerger(
            new JsonHooksOptions(path, "droid", [new("SessionStart"), new("Stop")], HookEntryShape.MatcherGroups, HookShell.Cmd) { HooksKey = null, DefaultTimeout = 10 },
            HookExe);

        merger.Install();

        var root = Read(path);
        root.Select(kv => kv.Key).Should().Equal("PreToolUse", "SessionStart", "Stop");
        var handler = (JsonObject)((JsonArray)((JsonObject)((JsonArray)root["Stop"]!)[0]!)["hooks"]!)[0]!;
        handler["command"]!.GetValue<string>().Should().Be($"\"{HookExe}\" --agent droid --event Stop");

        merger.Uninstall();
        Read(path).Select(kv => kv.Key).Should().Equal("PreToolUse");
    }

    [Fact]
    public void An_extra_own_entry_under_an_unknown_event_is_outdated()
    {
        var path = _dir.File("hooks.json");
        var merger = new JsonHooksMerger(
            new JsonHooksOptions(path, "cursor", [new("stop")], HookEntryShape.FlatCommands, HookShell.Any) { FileVersion = 1 }, HookExe);
        merger.Install();
        var root = Read(path);
        ((JsonObject)root["hooks"]!)["preToolUse"] = new JsonArray(new JsonObject { ["command"] = "agenthub-hook.exe --agent cursor --event preToolUse" });
        File.WriteAllText(path, root.ToJsonString());

        merger.GetStatus().State.Should().Be(HookInstallState.Outdated);
        merger.Install();
        merger.GetStatus().State.Should().Be(HookInstallState.Installed);
        ((JsonObject)Read(path)["hooks"]!).ContainsKey("preToolUse").Should().BeFalse("install removes stray own entries");
    }

    [Theory]
    [InlineData("{ // comment\n \"hooks\": {} }")]
    [InlineData("""{ "hooks": { "stop": {} } }""")]
    [InlineData("[]")]
    public void Strict_files_with_comments_or_wrong_shapes_are_never_rewritten(string content)
    {
        var path = _dir.File("hooks.json");
        File.WriteAllText(path, content);
        var merger = new JsonHooksMerger(new JsonHooksOptions(path, "cursor", [new("stop")], HookEntryShape.FlatCommands, HookShell.Any), HookExe);

        merger.Invoking(m => m.Install()).Should().Throw<HookConfigException>();

        File.ReadAllText(path).Should().Be(content);
    }

    [Theory]
    [InlineData(HookShell.Cmd, "\"C:\\a b\\agenthub-hook.exe\" --agent x --event E")]
    [InlineData(HookShell.PowerShell, "& 'C:\\a b\\agenthub-hook.exe' --agent x --event E")]
    public void Command_forms_quote_paths_with_spaces(HookShell shell, string expected)
    {
        var form = HookCommandLine.For(shell, @"C:\a b\agenthub-hook.exe", "x", "E", windows: true);

        form.Command.Should().Be(expected);
        form.Runs.Should().BeTrue();
        HookCommand.ExePath(form.Command).Should().Be(@"C:\a b\agenthub-hook.exe");
    }

    [Fact]
    public void Unquoted_forms_keep_a_path_without_spaces_as_is()
    {
        HookCommandLine.For(HookShell.CmdUnquoted, @"C:\tools\agenthub-hook.exe", "x", "E", windows: true).Should().Be(new HookCommandForm(@"C:\tools\agenthub-hook.exe --agent x --event E", true));
        HookCommandLine.For(HookShell.Any, @"C:\tools\agenthub-hook.exe", "x", "E", windows: true).Command.Should().Be("C:/tools/agenthub-hook.exe --agent x --event E");
        HookCommandLine.PowerShell(@"C:\it's\agenthub-hook.exe", "x", "E").Should().Be(@"& 'C:\it''s\agenthub-hook.exe' --agent x --event E");
        HookCommand.ExePath(HookCommandLine.PowerShell(@"C:\it's\agenthub-hook.exe", "x", "E")).Should().Be(@"C:\it's\agenthub-hook.exe", "'' is PowerShell's escaped quote");
        HookCommand.ExePath("'/usr/local/bin/agenthub-hook' --agent x").Should().Be("/usr/local/bin/agenthub-hook");
    }

    private const string MacHookExe = "/Users/u/Library/Application Support/kotilo/hub/bin/kotilo-hook";

    [Theory]
    [InlineData(HookShell.CmdUnquoted)]
    [InlineData(HookShell.Any)]
    [InlineData(HookShell.PowerShell)]
    public void Off_windows_the_non_cmd_forms_are_posix_shell_commands(HookShell shell)
    {
        // macOS: the data folder has a space, so the path is single-quoted (sh -c / bash -c), and it always runs.
        HookCommandLine.For(shell, MacHookExe, "x", "E", windows: false)
            .Should().Be(new HookCommandForm($"'{MacHookExe}' --agent x --event E", true));

        // Linux: a plain path stays unquoted, the same text as before, so existing entries stay current.
        HookCommandLine.For(shell, "/home/u/.local/share/kotilo/hub/bin/kotilo-hook", "x", "E", windows: false)
            .Should().Be(new HookCommandForm("/home/u/.local/share/kotilo/hub/bin/kotilo-hook --agent x --event E", true));

        var odd = HookCommandLine.For(shell, "/Users/O'Neil/$HOME/kotilo-hook", "x", "E", windows: false).Command;
        odd.Should().Be(@"'/Users/O'\''Neil/$HOME/kotilo-hook' --agent x --event E");
        HookCommand.ExePath(odd).Should().Be("/Users/O'Neil/$HOME/kotilo-hook", @"'\'' is the POSIX escaped quote");
    }

    [Fact]
    public void Off_windows_the_cmd_form_keeps_its_double_quotes()
    {
        HookCommandLine.For(HookShell.Cmd, MacHookExe, "x", "E", windows: false)
            .Should().Be(new HookCommandForm($"\"{MacHookExe}\" --agent x --event E", true), "sh reads it the same; Claude/Droid entries stay current");
    }

    [Theory]
    [InlineData(HookShell.CmdUnquoted)]
    [InlineData(HookShell.Any)]
    [InlineData(HookShell.PowerShell)]
    public void A_path_with_spaces_and_a_quote_installs_reads_back_and_stays_installed(HookShell shell)
    {
        var path = _dir.File("hooks.json");
        var exe = OsForm.Pick(@"C:\Users\Dev O'Neil\AppData\Local\kotilo\hub\bin\kotilo-hook.exe", "/Users/Dev O'Neil/Library/Application Support/kotilo/hub/bin/kotilo-hook");
        var merger = new JsonHooksMerger(new JsonHooksOptions(path, "x", [new("E")], HookEntryShape.MatcherGroups, shell), exe);

        merger.Install();

        merger.GetStatus().State.Should().Be(HookInstallState.Installed);
        merger.ReferencedHookExes().Should().Equal(exe);
        merger.Install().Should().BeNull("nothing changed");
    }

    [Fact]
    public void A_powershell_entry_from_an_older_build_is_installed_on_windows_and_outdated_elsewhere()
    {
        var path = _dir.File("settings.json");
        File.WriteAllText(path, $$"""{ "hooks": { "AfterAgent": [ { "hooks": [ { "type": "command", "command": "& '/home/u/.local/share/kotilo/hub/bin/kotilo-hook' --agent gemini --event AfterAgent", "timeout": 5 } ] } ] } }""");
        var merger = new JsonHooksMerger(
            new JsonHooksOptions(path, "gemini", [new("AfterAgent")], HookEntryShape.MatcherGroups, HookShell.PowerShell) { OwnedMarkers = ["kotilo-hook"] },
            "/home/u/.local/share/kotilo/hub/bin/kotilo-hook");

        merger.GetStatus().State.Should().Be(OsForm.Pick(HookInstallState.Installed, HookInstallState.Outdated), "the & form is a sh syntax error, so it is ours and gets repaired");
    }
}
