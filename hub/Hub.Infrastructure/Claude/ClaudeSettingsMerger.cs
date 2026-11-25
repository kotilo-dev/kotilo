using System.Text.Json;
using System.Text.Json.Nodes;
using Hub.Core.Adapters;
using Hub.Infrastructure.Hooks;

namespace Hub.Infrastructure.Claude;

/// <summary>
/// Claude Code's user <c>settings.json</c>: Kotilo hook entries (through <see cref="JsonHooksMerger"/>, spec §5.4,
/// decision D-020) plus the statusLine, <c>/voice</c> and <c>language</c> settings, without touching anything else.
/// Entries are recognised by the hook exe file name.
/// </summary>
public sealed class ClaudeSettingsMerger(string settingsPath, string hookExePath, TimeProvider? time = null) : IHookInstaller
{
    /// <summary>Events Kotilo registers. Value: whether the event takes a matcher.</summary>
    public static readonly IReadOnlyList<(string Event, bool HasMatcher)> Events =
    [
        ("SessionStart", true),
        ("UserPromptSubmit", false),
        ("PreToolUse", true),
        ("PostToolUse", true),
        ("PostToolUseFailure", true),
        ("PermissionRequest", true),
        ("Notification", true),
        ("Stop", false),
        ("StopFailure", true),
        ("SubagentStart", true),
        ("SubagentStop", true),
        ("SessionEnd", true),
    ];

    private const int HookTimeoutSeconds = 5;

    private readonly JsonHooksMerger _hooks = new(
        new JsonHooksOptions(
            settingsPath,
            AgentIds.ClaudeCode,
            Events.Select(e => new HookEventSpec(e.Event, HookTimeoutSeconds, e.HasMatcher ? string.Empty : null)).ToList(),
            HookEntryShape.MatcherGroups,
            HookShell.Cmd)
        {
            AllowComments = true,
            Description = "Claude Code settings",
        },
        hookExePath,
        time);

    private readonly JsonConfigFile _file = new(settingsPath, allowComments: true, time);

    public string ConfigPath => settingsPath;

    /// <summary>The hook command for one event: <c>"&lt;exe&gt;" --agent claude-code --event &lt;Event&gt;</c>.</summary>
    public string CommandFor(string eventName) => _hooks.CommandFor(eventName);

    public HookInstallState GetState() => _hooks.GetState();

    public HookStatus GetStatus() => _hooks.GetStatus();

    /// <summary>Installs or repairs Kotilo entries. Returns the backup path, or null if nothing changed.</summary>
    public string? Install() => _hooks.Install();

    /// <summary>Removes only Kotilo entries. Returns the backup path, or null if there was nothing to remove.</summary>
    public string? Uninstall() => _hooks.Uninstall();

    public HookInstallState GetState(JsonObject root) => _hooks.GetState(root);

    /// <summary>Exe paths of every Kotilo hook command in settings.json (to check they still exist, spec §18.6).</summary>
    public IReadOnlyList<string> ReferencedHookExes() => _hooks.ReferencedHookExes();

    /// <summary>The configured statusLine command, or null.</summary>
    public string? GetStatusLineCommand() => StatusLineCommand(Load());

    /// <summary>Ours under the current exe name or a legacy one from before a rename.</summary>
    public static bool IsOwnStatusLine(string? command) =>
        command is not null && AppPaths.OwnedStatusLineExeNames.Any(n => command.Contains(n, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Points statusLine at the Kotilo exe (spec §9). The user's previous command is returned so the caller can
    /// store it as <c>wrappedCommand</c>; null when there was none or Kotilo was already installed.
    /// </summary>
    /// <exception cref="HookConfigException">settings.json is not valid JSON; the file is untouched.</exception>
    public (string? Backup, string? PreviousCommand) InstallStatusLine(string statusLineExePath)
    {
        var root = LoadGuarded();
        var previous = StatusLineCommand(root);
        var command = $"\"{statusLineExePath}\"";
        if (string.Equals(previous, command, StringComparison.OrdinalIgnoreCase))
        {
            return (null, null);
        }

        var statusLine = root["statusLine"] as JsonObject ?? [];
        statusLine["type"] = "command";
        statusLine["command"] = command;
        root["statusLine"] = statusLine;
        return (Save(root), IsOwnStatusLine(previous) ? null : previous);
    }

    /// <summary>Restores <paramref name="wrappedCommand"/> (or removes statusLine) if the hub's command is installed.</summary>
    /// <exception cref="HookConfigException">settings.json is not valid JSON; the file is untouched.</exception>
    public string? UninstallStatusLine(string? wrappedCommand)
    {
        var root = LoadGuarded();
        if (!IsOwnStatusLine(StatusLineCommand(root)))
        {
            return null;
        }

        if (string.IsNullOrWhiteSpace(wrappedCommand))
        {
            root.Remove("statusLine");
        }
        else
        {
            ((JsonObject)root["statusLine"]!)["command"] = wrappedCommand;
        }

        return Save(root);
    }

    /// <summary>
    /// Where the statusLine stands for <paramref name="statusLineExePath"/>: ours (<see cref="StatusLineState.Installed"/>),
    /// ours but pointing at another exe (<see cref="StatusLineState.Outdated"/>), someone else's or none
    /// (<see cref="StatusLineState.Missing"/>), or settings.json unreadable (<see cref="StatusLineState.InvalidConfig"/>).
    /// </summary>
    public StatusLineState GetStatusLineState(string statusLineExePath)
    {
        try
        {
            var command = StatusLineCommand(Load());
            if (!IsOwnStatusLine(command))
            {
                return StatusLineState.Missing;
            }

            return string.Equals(command, $"\"{statusLineExePath}\"", StringComparison.OrdinalIgnoreCase)
                ? StatusLineState.Installed
                : StatusLineState.Outdated;
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException)
        {
            return StatusLineState.InvalidConfig;
        }
    }

    /// <summary>Claude Code's own <c>/voice</c> dictation settings (spec §22.6): <c>voice.enabled</c>, <c>voice.mode</c>, <c>language</c>.</summary>
    public ClaudeVoiceStatus GetVoiceStatus()
    {
        var root = Load();
        var voice = root["voice"] as JsonObject;
        return new ClaudeVoiceStatus(
            voice?["enabled"]?.GetValueKind() == JsonValueKind.True,
            String(voice?["mode"]),
            String(root["language"]));

        static string? String(JsonNode? node) => node?.GetValueKind() == JsonValueKind.String ? node.GetValue<string>() : null;
    }

    /// <summary>
    /// Sets the top-level <c>language</c>, which drives both Claude Code's dictation language and its reply language.
    /// Returns the backup path, or null when it already had this value.
    /// </summary>
    public string? SetLanguage(string language)
    {
        var root = Load();
        if (root["language"]?.GetValueKind() == JsonValueKind.String && root["language"]!.GetValue<string>() == language)
        {
            return null;
        }

        root["language"] = language;
        return Save(root);
    }

    private static string? StatusLineCommand(JsonObject root) =>
        root["statusLine"] is JsonObject s && s["command"]?.GetValueKind() == JsonValueKind.String
            ? s["command"]!.GetValue<string>()
            : null;

    public static bool IsOwnCommand(string? command) => HookCommand.IsOwn(command);

    private JsonObject Load() => _file.Load();

    private JsonObject LoadGuarded()
    {
        try
        {
            return _file.Load();
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException)
        {
            throw new HookConfigException($"{settingsPath} could not be read as Claude Code settings: {ex.Message}", ex);
        }
    }

    private string? Save(JsonObject root) => _file.Save(root);
}

/// <summary>Whether Kotilo's statusLine helper is what Claude Code's <c>statusLine</c> setting points at.</summary>
public enum StatusLineState
{
    Missing,
    Installed,
    Outdated,
    InvalidConfig,
}

/// <summary>Claude Code <c>/voice</c> state read from settings.json; <see cref="Language"/> null means English.</summary>
public sealed record ClaudeVoiceStatus(bool Enabled, string? Mode, string? Language)
{
    /// <summary>The <c>language</c> value selects Turkish dictation ("tr", "tr-TR", "turkish", "Türkçe").</summary>
    public bool IsTurkish => Language is { } l && (l.StartsWith("tr", StringComparison.OrdinalIgnoreCase) || l.Equals("Türkçe", StringComparison.OrdinalIgnoreCase));
}
