using System.Text.Json.Nodes;
using Hub.Core.Adapters;
using Hub.Infrastructure.Cursor;

namespace Hub.Infrastructure.Tests;

/// <summary><c>~/.cursor/hooks.json</c>: observational events only, shell-neutral command. Temp folder only.</summary>
public sealed class CursorHooksMergerTests : IDisposable
{
    private const string HookExe = @"C:\Users\u\AppData\Local\agent-hub\hub\bin\agenthub-hook.exe";
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private static JsonObject Read(string path) => (JsonObject)JsonNode.Parse(File.ReadAllText(path))!;

    [Fact]
    public void Registers_only_observational_events_with_the_shell_neutral_command()
    {
        var path = _dir.File("hooks.json");
        var merger = new CursorHooksMerger(path, HookExe);

        merger.Install();

        var root = Read(path);
        root["version"]!.GetValue<int>().Should().Be(1);
        var hooks = (JsonObject)root["hooks"]!;
        hooks.Select(kv => kv.Key).Should().BeEquivalentTo("sessionStart", "sessionEnd", "postToolUse", "afterShellExecution", "afterFileEdit", "stop");
        hooks.Select(kv => kv.Key).Should().NotContain(
            ["preToolUse", "beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "beforeSubmitPrompt", "subagentStart"],
            "deciding hooks would make agent-hub part of Cursor's permission answer (D-025)");
        var entry = (JsonObject)hooks["afterShellExecution"]![0]!;
        entry["command"]!.GetValue<string>().Should().Be(OsForm.Pick(
            "C:/Users/u/AppData/Local/agent-hub/hub/bin/agenthub-hook.exe --agent cursor --event afterShellExecution",
            $"'{HookExe}' --agent cursor --event afterShellExecution"));
        entry["timeout"]!.GetValue<int>().Should().Be(5);
        merger.CommandRunsOnWindows.Should().BeTrue();
        merger.GetStatus().Should().Be(new HookStatus(HookInstallState.Installed, path));
    }

    [Fact]
    public void Keeps_the_users_hooks_including_their_own_permission_hook()
    {
        var path = _dir.File("hooks.json");
        var user = """{ "version": 1, "hooks": { "preToolUse": [ { "command": "./guard.ps1", "failClosed": true } ], "stop": [ { "command": "notify.exe" } ] } }""";
        File.WriteAllText(path, user);
        var merger = new CursorHooksMerger(path, HookExe);

        merger.Install().Should().NotBeNull("the user's file is backed up first");

        var hooks = (JsonObject)Read(path)["hooks"]!;
        ((JsonArray)hooks["preToolUse"]!).Should().ContainSingle();
        ((JsonArray)hooks["stop"]!).Should().HaveCount(2);

        merger.Uninstall();

        JsonNode.DeepEquals(Read(path), JsonNode.Parse(user)).Should().BeTrue();
        merger.GetStatus().State.Should().Be(HookInstallState.Missing);
    }
}
