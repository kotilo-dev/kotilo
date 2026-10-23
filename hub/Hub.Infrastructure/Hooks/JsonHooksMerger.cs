using System.Text.Json;
using System.Text.Json.Nodes;
using Hub.Core.Adapters;
using Hub.Infrastructure.Platform;

namespace Hub.Infrastructure.Hooks;

/// <summary>How an agent's hook config lays out one event's entries.</summary>
public enum HookEntryShape
{
    /// <summary>Claude Code (also Gemini, Qwen, Droid): <c>&lt;Event&gt;: [{matcher?, hooks: [{type: "command", command, timeout}]}]</c>.</summary>
    MatcherGroups,

    /// <summary>Codex: groups without a matcher; each handler has <c>command</c> and <c>commandWindows</c>.</summary>
    CodexGroups,

    /// <summary>Cursor: <c>&lt;event&gt;: [{command, timeout}]</c> in a file with <c>version: 1</c>.</summary>
    FlatCommands,

    /// <summary>Copilot CLI: <c>&lt;event&gt;: [{type: "command", powershell, bash, timeoutSec}]</c> in a file with <c>version: 1</c>.</summary>
    CopilotCommands,
}

/// <summary>One event Kotilo registers.</summary>
/// <param name="Timeout">In the agent's own unit (seconds, or ms for Gemini); null: <see cref="JsonHooksOptions.DefaultTimeout"/>.</param>
/// <param name="Matcher">Written as the group's <c>matcher</c> when not null (<c>""</c> = everything); grouped shapes only.</param>
public sealed record HookEventSpec(string Event, int? Timeout = null, string? Matcher = null);

/// <summary>Everything that differs between agents' JSON hook configs.</summary>
/// <param name="ConfigPath">The file the hooks live in.</param>
/// <param name="AgentId">Goes into every command as <c>--agent</c>.</param>
public sealed record JsonHooksOptions(string ConfigPath, string AgentId, IReadOnlyList<HookEventSpec> Events, HookEntryShape Shape, HookShell Shell)
{
    public int DefaultTimeout { get; init; } = 5;

    /// <summary>The agent reads its file as JSONC (comments, trailing commas). Otherwise a comment makes the file invalid.</summary>
    public bool AllowComments { get; init; }

    /// <summary>Object that holds the events (<c>hooks</c>); null when the events are top-level keys (Droid <c>hooks.json</c>).</summary>
    public string? HooksKey { get; init; } = "hooks";

    /// <summary>Top-level <c>version</c> the file must have (Cursor, Copilot); added when missing, never changed.</summary>
    public int? FileVersion { get; init; }

    /// <summary>The file belongs to Kotilo alone (Copilot <c>hooks/agenthub.json</c>): uninstall deletes it once it is empty.</summary>
    public bool OwnFile { get; init; }

    /// <summary>What the file is, for error messages ("Claude Code settings").</summary>
    public string Description { get; init; } = "agent hooks";

    /// <summary>Entries whose command contains one of these are ours: the brand's marker and its legacy ones (tests override it).</summary>
    public IReadOnlyList<string> OwnedMarkers { get; init; } = Hub.Core.Brand.Current.OwnedHookMarkers;
}

/// <summary>
/// Backup-first add / remove of Kotilo hook entries in an agent's JSON config (AGENTS.md rule 4, D-008), for every
/// <see cref="HookEntryShape"/>. Only entries whose command contains <c>agenthub-hook</c> are touched; everything else in the
/// file is kept, a file that can't be parsed is reported and never rewritten.
/// </summary>
public sealed class JsonHooksMerger : IHookInstaller
{
    private static readonly string[] CommandFields = ["command", "commandWindows", "command_windows", "powershell", "bash"];

    private readonly JsonHooksOptions _options;
    private readonly string _hookExePath;
    private readonly Dictionary<string, HookCommandForm> _commands;

    public JsonHooksMerger(JsonHooksOptions options, string hookExePath, TimeProvider? time = null)
    {
        _options = options;
        _hookExePath = hookExePath;
        File = new JsonConfigFile(options.ConfigPath, options.AllowComments, time);
        _commands = options.Events.ToDictionary(e => e.Event, e => Form(e.Event), StringComparer.Ordinal);
    }

    public JsonHooksOptions Options => _options;

    public JsonConfigFile File { get; }

    public string ConfigPath => _options.ConfigPath;

    /// <summary>False when the shell form needs a path without spaces and there is none: the entries are written but won't run.</summary>
    public bool CommandRunsOnWindows => _commands.Values.All(c => c.Runs);

    /// <summary>The command written for <paramref name="eventName"/> (for Copilot: the <c>powershell</c> field).</summary>
    public string CommandFor(string eventName) =>
        _commands.TryGetValue(eventName, out var form) ? form.Command : Form(eventName).Command;

    public HookStatus GetStatus()
    {
        try
        {
            return new HookStatus(GetState(File.Load()), ConfigPath);
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException)
        {
            return new HookStatus(HookInstallState.InvalidConfig, ConfigPath);
        }
    }

    /// <exception cref="JsonException">The file is not valid JSON.</exception>
    public HookInstallState GetState() => GetState(File.Load());

    /// <summary>Missing: no own entry. Installed: exactly one current entry per event and none elsewhere. Otherwise outdated.</summary>
    public HookInstallState GetState(JsonObject root)
    {
        var container = Container(root, create: false, strict: false);
        var found = 0;
        var current = 0;
        foreach (var spec in _options.Events)
        {
            var handlers = OwnHandlers(container?[spec.Event] as JsonArray).Select(h => h.Handler).ToList();
            found += handlers.Count;
            if (handlers.Any(h => IsCurrent(h, spec.Event)))
            {
                current++;
            }
        }

        var stray = container?.Where(kv => !_options.Events.Any(e => e.Event == kv.Key)).Sum(kv => OwnHandlers(kv.Value as JsonArray).Count()) ?? 0;
        if (found + stray == 0)
        {
            return HookInstallState.Missing;
        }

        return current == _options.Events.Count && found == _options.Events.Count && stray == 0
            ? HookInstallState.Installed
            : HookInstallState.Outdated;
    }

    /// <summary>Installs or repairs our entries. Returns the backup path, or null if nothing changed.</summary>
    public string? Install() => Guarded(() =>
    {
        var root = File.Load();
        if (GetState(root) == HookInstallState.Installed)
        {
            return null;
        }

        RemoveOwnEntries(root);
        if (_options.FileVersion is { } version && !root.ContainsKey("version"))
        {
            root["version"] = version;
        }

        var container = Container(root, create: true, strict: true)!;
        foreach (var spec in _options.Events)
        {
            var entries = container[spec.Event] switch
            {
                null => [],
                JsonArray existing => existing,
                _ => throw new InvalidDataException($"'{Describe(spec.Event)}' in {ConfigPath} is not an array."),
            };
            container[spec.Event] = entries;
            entries.Add(Entry(spec));
        }

        return File.Save(root);
    });

    /// <summary>Removes only our entries. Returns the backup path, or null if there was nothing to remove.</summary>
    public string? Uninstall() => Guarded(() =>
    {
        var root = File.Load();
        if (!RemoveOwnEntries(root))
        {
            return null;
        }

        return _options.OwnFile && root.All(kv => kv.Key == "version") ? File.Delete() : File.Save(root);
    });

    public IReadOnlyList<string> ReferencedHookExes() => Guarded(() =>
    {
        var container = Container(File.Load(), create: false, strict: false);
        return (container ?? [])
            .SelectMany(kv => OwnHandlers(kv.Value as JsonArray))
            .Select(h => PrimaryCommand(h.Handler))
            .OfType<string>()
            .Select(HookCommand.ExePath)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    });

    /// <summary>Our handlers in <paramref name="root"/> with their positions (Codex trust keys use group and handler index).</summary>
    public IEnumerable<(string Event, int Group, int Index, JsonObject Handler)> OwnHandlerPositions(JsonObject root)
    {
        var container = Container(root, create: false, strict: false);
        foreach (var (eventName, node) in container ?? [])
        {
            foreach (var (group, index, handler) in OwnHandlers(node as JsonArray))
            {
                yield return (eventName, group, index, handler);
            }
        }
    }

    /// <summary>
    /// The command in the adapter's shell form. Copilot's <c>powershell</c> field is read by PowerShell on every OS
    /// (Unix uses the <c>bash</c> field), so it keeps the PowerShell form off Windows too.
    /// </summary>
    private HookCommandForm Form(string eventName) => _options.Shape == HookEntryShape.CopilotCommands
        ? new(HookCommandLine.PowerShell(_hookExePath, _options.AgentId, eventName), true)
        : HookCommandLine.For(_options.Shell, _hookExePath, _options.AgentId, eventName);

    private bool Grouped => _options.Shape is HookEntryShape.MatcherGroups or HookEntryShape.CodexGroups;

    private JsonObject Entry(HookEventSpec spec)
    {
        var command = CommandFor(spec.Event);
        var timeout = spec.Timeout ?? _options.DefaultTimeout;
        switch (_options.Shape)
        {
            case HookEntryShape.CodexGroups:
                // No matcher: Codex treats a missing matcher as "match everything".
                return new JsonObject
                {
                    ["hooks"] = new JsonArray(new JsonObject
                    {
                        ["type"] = "command",
                        ["command"] = command,
                        ["commandWindows"] = command,
                        ["timeout"] = timeout,
                    }),
                };

            case HookEntryShape.FlatCommands:
                return new JsonObject { ["command"] = command, ["timeout"] = timeout };

            case HookEntryShape.CopilotCommands:
                return new JsonObject
                {
                    ["type"] = "command",
                    ["powershell"] = command,
                    ["bash"] = HookCommandLine.Posix(_hookExePath, _options.AgentId, spec.Event),
                    ["timeoutSec"] = timeout,
                };

            case HookEntryShape.MatcherGroups:
            default:
                var group = new JsonObject();
                if (spec.Matcher is { } matcher)
                {
                    group["matcher"] = matcher;
                }

                group["hooks"] = new JsonArray(new JsonObject
                {
                    ["type"] = "command",
                    ["command"] = command,
                    ["timeout"] = timeout,
                });
                return group;
        }
    }

    private bool IsCurrent(JsonObject handler, string eventName)
    {
        var expected = CommandFor(eventName);
        return _options.Shape switch
        {
            HookEntryShape.CodexGroups => Same(Str(handler["command"]), expected)
                && Same(Str(handler["commandWindows"]) ?? Str(handler["command_windows"]), expected),
            HookEntryShape.CopilotCommands => Same(Str(handler["powershell"]), expected),
            _ => Same(Str(handler["command"]), expected),
        };

        static bool Same(string? a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>The events object; null when absent. <paramref name="strict"/>: a wrong type throws instead of reading as absent.</summary>
    private JsonObject? Container(JsonObject root, bool create, bool strict)
    {
        if (_options.HooksKey is not { } key)
        {
            return root;
        }

        switch (root[key])
        {
            case JsonObject existing:
                return existing;
            case null:
                if (!create)
                {
                    return null;
                }

                var hooks = new JsonObject();
                root[key] = hooks;
                return hooks;
            default:
                return strict ? throw new InvalidDataException($"'{key}' in {ConfigPath} is not an object.") : null;
        }
    }

    private IEnumerable<(int Group, int Index, JsonObject Handler)> OwnHandlers(JsonArray? entries)
    {
        if (entries is null)
        {
            yield break;
        }

        for (var g = 0; g < entries.Count; g++)
        {
            if (entries[g] is not JsonObject entry)
            {
                continue;
            }

            if (!Grouped)
            {
                if (IsOwn(entry))
                {
                    yield return (g, 0, entry);
                }

                continue;
            }

            if (entry["hooks"] is not JsonArray handlers)
            {
                continue;
            }

            for (var h = 0; h < handlers.Count; h++)
            {
                if (handlers[h] is JsonObject handler && IsOwn(handler))
                {
                    yield return (g, h, handler);
                }
            }
        }
    }

    private bool RemoveOwnEntries(JsonObject root)
    {
        if (Container(root, create: false, strict: false) is not { } container)
        {
            return false;
        }

        var removed = false;
        foreach (var eventName in container.Select(kv => kv.Key).ToList())
        {
            if (container[eventName] is not JsonArray entries)
            {
                continue;
            }

            foreach (var entry in entries.OfType<JsonObject>().ToList())
            {
                if (!Grouped)
                {
                    if (IsOwn(entry))
                    {
                        entries.Remove(entry);
                        removed = true;
                    }

                    continue;
                }

                if (entry["hooks"] is not JsonArray handlers)
                {
                    continue;
                }

                foreach (var handler in handlers.OfType<JsonObject>().Where(IsOwn).ToList())
                {
                    handlers.Remove(handler);
                    removed = true;
                }

                if (handlers.Count == 0)
                {
                    entries.Remove(entry);
                }
            }

            if (entries.Count == 0)
            {
                container.Remove(eventName);
            }
        }

        if (_options.HooksKey is { } key && container.Count == 0)
        {
            root.Remove(key);
        }

        return removed;
    }

    private bool IsOwn(JsonObject handler) => CommandFields.Any(f => HookCommand.IsOwn(Str(handler[f]), _options.OwnedMarkers));

    private string? PrimaryCommand(JsonObject handler) =>
        CommandFields.Select(f => Str(handler[f])).FirstOrDefault(c => HookCommand.IsOwn(c, _options.OwnedMarkers));

    private static string? Str(JsonNode? node) => node?.GetValueKind() == JsonValueKind.String ? node.GetValue<string>() : null;

    private string Describe(string eventName) => _options.HooksKey is { } key ? $"{key}.{eventName}" : eventName;

    /// <summary>Turns "could not understand the file" into <see cref="HookConfigException"/>; the file is untouched.</summary>
    private T Guarded<T>(Func<T> action)
    {
        try
        {
            return action();
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException)
        {
            throw new HookConfigException($"{ConfigPath} could not be read as {_options.Description}: {ex.Message}", ex);
        }
    }
}
