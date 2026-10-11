using System.Text.Json;
using System.Text.Json.Nodes;
using Hub.Core.Adapters;
using Hub.Infrastructure.Hooks;

namespace Hub.Infrastructure.Droid;

/// <summary>
/// Factory Droid's user hooks (docs.factory.com/harness/hooks): <c>~/.factory/hooks.json</c> with the events as top-level
/// keys, or, when <c>hooks.json</c> is absent, the <c>hooks</c> key of <c>~/.factory/settings.json</c>. Creating
/// <c>hooks.json</c> would silently hide hooks the user keeps in <c>settings.json</c>, so the target is:
/// <list type="bullet">
/// <item><c>hooks.json</c> when it exists, or when <c>settings.json</c> has no non-empty <c>hooks</c>;</item>
/// <item>otherwise the <c>hooks</c> key of <c>settings.json</c>.</item>
/// </list>
/// Status reports the target file. Install also removes our stale entries from the other file (e.g. the user created
/// <c>hooks.json</c> after we wrote <c>settings.json</c>); uninstall removes our entries from both. Droid runs hook commands
/// through <c>cmd.exe /d /s /c</c>, so the quoted command form works (D-023). Droid snapshots hooks at startup: a change
/// applies from the next session.
/// </summary>
public sealed class DroidHooksInstaller : IHookInstaller
{
    /// <summary>Events Kotilo registers. Value: the matcher (<c>"*"</c> = every tool) or null for events without one.</summary>
    public static readonly IReadOnlyList<(string Event, string? Matcher)> Events =
    [
        ("SessionStart", null),
        ("SessionEnd", null),
        ("UserPromptSubmit", null),
        ("PreToolUse", "*"),
        ("PostToolUse", "*"),
        ("Notification", null),
        ("Stop", null),
        ("SubagentStop", null),
        ("PreCompact", null),
    ];

    /// <summary>Seconds (Droid's default is 60); the hook returns within ~300 ms.</summary>
    private const int TimeoutSeconds = 10;

    private readonly JsonHooksMerger _hooksJson;
    private readonly JsonHooksMerger _settings;
    private readonly JsonConfigFile _settingsReader;

    /// <param name="droidHome"><c>~/.factory</c>.</param>
    public DroidHooksInstaller(string droidHome, string hookExePath, TimeProvider? time = null)
    {
        HooksJsonPath = Path.Combine(droidHome, "hooks.json");
        SettingsPath = Path.Combine(droidHome, "settings.json");
        var events = Events.Select(e => new HookEventSpec(e.Event, TimeoutSeconds, e.Matcher)).ToList();
        _hooksJson = new JsonHooksMerger(
            new JsonHooksOptions(HooksJsonPath, AgentIds.Droid, events, HookEntryShape.MatcherGroups, HookShell.Cmd)
            {
                HooksKey = null,
                DefaultTimeout = TimeoutSeconds,
                Description = "Droid hooks",
            },
            hookExePath,
            time);
        _settings = new JsonHooksMerger(
            new JsonHooksOptions(SettingsPath, AgentIds.Droid, events, HookEntryShape.MatcherGroups, HookShell.Cmd)
            {
                DefaultTimeout = TimeoutSeconds,
                Description = "Droid settings",
            },
            hookExePath,
            time);

        // Read-only and tolerant: only decides whether settings.json holds hooks. Writes stay strict JSON.
        _settingsReader = new JsonConfigFile(SettingsPath, allowComments: true, time);
    }

    public string HooksJsonPath { get; }

    public string SettingsPath { get; }

    /// <summary>The file Droid reads our hooks from (see the class summary).</summary>
    public string ConfigPath => Target().ConfigPath;

    /// <summary>The command written for one event: <c>"&lt;exe&gt;" --agent droid --event &lt;Event&gt;</c>.</summary>
    public string CommandFor(string eventName) => _hooksJson.CommandFor(eventName);

    public HookStatus GetStatus()
    {
        var target = Target();
        var status = target.GetStatus();
        if (status.State == HookInstallState.Installed && HasOwnEntries(Other(target)))
        {
            // Leftovers in the file Droid does not read: Install cleans them up.
            status = status with { State = HookInstallState.Outdated };
        }

        return HooksDisabled() ? status with { Hint = HookHints.HooksDisabled } : status;
    }

    public string? Install()
    {
        var target = Target();
        var backup = target.Install();
        var other = Other(target);
        if (HasOwnEntries(other))
        {
            var otherBackup = other.Uninstall();
            backup ??= otherBackup;
        }

        return backup;
    }

    public string? Uninstall()
    {
        string? backup = null;
        HookConfigException? failure = null;
        var target = Target();
        foreach (var merger in new[] { target, Other(target) })
        {
            try
            {
                backup = merger.Uninstall() ?? backup;
            }
            catch (HookConfigException ex)
            {
                failure ??= ex;
            }
        }

        return failure is null ? backup : throw failure;
    }

    public IReadOnlyList<string> ReferencedHookExes()
    {
        var target = Target();
        var exes = target.ReferencedHookExes().ToList();
        try
        {
            exes.AddRange(Other(target).ReferencedHookExes());
        }
        catch (HookConfigException)
        {
            // The file Droid doesn't read can't be parsed: nothing of ours there runs.
        }

        return exes.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    private JsonHooksMerger Target()
    {
        if (File.Exists(HooksJsonPath))
        {
            return _hooksJson;
        }

        try
        {
            return _settingsReader.Load()["hooks"] is null or JsonObject { Count: 0 } ? _hooksJson : _settings;
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException or IOException)
        {
            // Can't tell whether settings.json holds hooks: never create hooks.json over them. Status says invalidConfig.
            return _settings;
        }
    }

    /// <summary><c>hooksDisabled: true</c> in <c>settings.json</c> switches every Droid hook off.</summary>
    private bool HooksDisabled()
    {
        try
        {
            return _settingsReader.Load()["hooksDisabled"]?.GetValueKind() == JsonValueKind.True;
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException or IOException)
        {
            return false;
        }
    }

    private JsonHooksMerger Other(JsonHooksMerger target) => ReferenceEquals(target, _hooksJson) ? _settings : _hooksJson;

    private static bool HasOwnEntries(JsonHooksMerger merger)
    {
        if (!merger.File.Exists)
        {
            return false;
        }

        try
        {
            return merger.GetState() != HookInstallState.Missing;
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException or IOException)
        {
            return false;
        }
    }
}
