using System.Text.Json;
using System.Text.Json.Nodes;
using Hub.Core.Adapters;
using Hub.Infrastructure.Hooks;

namespace Hub.Infrastructure.Qwen;

/// <summary>
/// Kotilo entries in Qwen Code's user <c>settings.json</c> (JSONC, Claude Code shape, timeouts in seconds; qwen-code 0.25
/// <c>docs/users/features/hooks.md</c>, docs/research/agents-gemini-qwen.md §2.1). Qwen runs Windows hooks through
/// <c>cmd /d /s /c</c> without verbatim arguments, so the command is written unquoted (8.3 path when needed, as for Codex,
/// D-013). PermissionRequest is never registered: Qwen awaits it and acts on its output. User hooks load regardless of
/// folder trust; Qwen reads them at session start, so an install applies to new sessions.
/// </summary>
public sealed class QwenHooksInstaller(string settingsPath, string hookExePath, TimeProvider? time = null) : IHookInstaller
{
    private const int TimeoutSeconds = 5;

    /// <summary>Events Kotilo registers; <c>""</c> (match everything) on events that take a matcher, like Claude's.</summary>
    public static readonly IReadOnlyList<HookEventSpec> Events =
    [
        new("SessionStart", TimeoutSeconds, string.Empty),
        new("SessionEnd", TimeoutSeconds, string.Empty),
        new("UserPromptSubmit", TimeoutSeconds),
        new("PreToolUse", TimeoutSeconds, string.Empty),
        new("PostToolUse", TimeoutSeconds, string.Empty),
        new("PostToolUseFailure", TimeoutSeconds, string.Empty),
        new("Notification", TimeoutSeconds, string.Empty),
        new("Stop", TimeoutSeconds),
        new("StopFailure", TimeoutSeconds, string.Empty),
    ];

    private readonly JsonHooksMerger _hooks = new(
        new JsonHooksOptions(settingsPath, AgentIds.Qwen, Events, HookEntryShape.MatcherGroups, HookShell.CmdUnquoted)
        {
            AllowComments = true,
            Description = "Qwen Code settings",
        },
        hookExePath,
        time);

    public string ConfigPath => settingsPath;

    /// <summary>False when the hook exe path has spaces and no 8.3 short form: the entries are written but Qwen can't run them.</summary>
    public bool CommandRunsOnWindows => _hooks.CommandRunsOnWindows;

    public string CommandFor(string eventName) => _hooks.CommandFor(eventName);

    public HookStatus GetStatus()
    {
        JsonObject root;
        try
        {
            root = _hooks.File.Load();
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException)
        {
            return new HookStatus(HookInstallState.InvalidConfig, settingsPath);
        }

        var state = _hooks.GetState(root);
        var disabled = state != HookInstallState.Missing && root["disableAllHooks"]?.GetValueKind() == JsonValueKind.True;
        return new HookStatus(state, settingsPath) { Hint = disabled ? HookHints.HooksDisabled : null };
    }

    public string? Install() => _hooks.Install();

    public string? Uninstall() => _hooks.Uninstall();

    public IReadOnlyList<string> ReferencedHookExes() => _hooks.ReferencedHookExes();
}
