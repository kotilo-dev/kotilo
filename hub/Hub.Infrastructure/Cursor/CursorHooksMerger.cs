using Hub.Core.Adapters;
using Hub.Infrastructure.Hooks;

namespace Hub.Infrastructure.Cursor;

/// <summary>
/// Cursor CLI's user hooks, <c>~/.cursor/hooks.json</c> (<c>{version: 1, hooks: {event: [{command, timeout}]}}</c>,
/// cursor.com/docs/hooks), through <see cref="JsonHooksMerger"/>. Only observational events (D-025): a permission hook
/// (<c>preToolUse</c>, <c>beforeShellExecution</c>, <c>beforeMCPExecution</c>, <c>beforeReadFile</c>, <c>subagentStart</c>) or
/// <c>beforeSubmitPrompt</c> would make Kotilo part of Cursor's decision. Cursor's Windows hook shell is cmd, PowerShell
/// or bash depending on the version and <c>MSYSTEM</c>, so the command is the shell-neutral form (unquoted forward-slash
/// path, 8.3 when it has spaces). Hooks are hot-reloaded by Cursor.
/// </summary>
public sealed class CursorHooksMerger(string hooksPath, string hookExePath, TimeProvider? time = null) : IHookInstaller
{
    /// <summary>The events Kotilo registers (research: these fire in the interactive CLI).</summary>
    public static readonly IReadOnlyList<string> Events =
        ["sessionStart", "sessionEnd", "postToolUse", "afterShellExecution", "afterFileEdit", "stop"];

    /// <summary>
    /// Seconds. Kept small: on Windows headless runs Cursor was reported to wait the full timeout (forum 169942).
    /// </summary>
    private const int TimeoutSeconds = 5;

    private readonly JsonHooksMerger _hooks = new(
        new JsonHooksOptions(hooksPath, AgentIds.Cursor, Events.Select(e => new HookEventSpec(e, TimeoutSeconds)).ToList(), HookEntryShape.FlatCommands, HookShell.Any)
        {
            FileVersion = 1,
            DefaultTimeout = TimeoutSeconds,
            Description = "Cursor hooks",
        },
        hookExePath,
        time);

    public string ConfigPath => hooksPath;

    /// <summary>False when the hook exe path has spaces and no 8.3 form: written, but not every Cursor shell can run it.</summary>
    public bool CommandRunsOnWindows => _hooks.CommandRunsOnWindows;

    public string CommandFor(string eventName) => _hooks.CommandFor(eventName);

    public HookStatus GetStatus() => _hooks.GetStatus();

    public string? Install() => _hooks.Install();

    public string? Uninstall() => _hooks.Uninstall();

    public IReadOnlyList<string> ReferencedHookExes() => _hooks.ReferencedHookExes();
}
