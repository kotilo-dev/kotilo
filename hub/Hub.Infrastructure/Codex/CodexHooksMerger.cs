using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Hub.Core.Adapters;
using Hub.Infrastructure.Hooks;

namespace Hub.Infrastructure.Codex;

/// <summary>
/// Adds / removes Kotilo entries in Codex's <c>$CODEX_HOME/hooks.json</c> (openai/codex 0.160,
/// <c>config/src/hook_config.rs</c>) through <see cref="JsonHooksMerger"/>, without touching anything else. Codex runs a
/// non-managed hook only after the user trusted it in <c>/hooks</c> (a
/// <c>[hooks.state."&lt;path&gt;:&lt;event&gt;:&lt;group&gt;:&lt;handler&gt;"]</c> table in <c>config.toml</c>); Kotilo never
/// writes that trust itself, it only reports <see cref="HookStatus.NeedsApproval"/>.
/// </summary>
public sealed class CodexHooksMerger(string hooksPath, string configTomlPath, string hookExePath, TimeProvider? time = null) : IHookInstaller
{
    /// <summary>Events Kotilo registers, with the handler timeout in seconds (SessionEnd/Interrupt allow at most 3).</summary>
    public static readonly IReadOnlyList<(string Event, int TimeoutSeconds)> Events =
    [
        ("SessionStart", 5),
        ("SessionEnd", 3),
        ("UserPromptSubmit", 5),
        ("PreToolUse", 5),
        ("PermissionRequest", 5),
        ("PostToolUse", 5),
        ("PostCompact", 5),
        ("Stop", 5),
        ("Interrupt", 3),
        ("SubagentStart", 5),
        ("SubagentStop", 5),
    ];

    // Codex runs Windows hooks as `cmd /C "<command>"`, which breaks on quotes inside the command (D-013).
    // Strict JSON (Codex's own reader allows no comments), so nothing is silently dropped on rewrite.
    private readonly JsonHooksMerger _hooks = new(
        new JsonHooksOptions(
            hooksPath,
            AgentIds.Codex,
            Events.Select(e => new HookEventSpec(e.Event, e.TimeoutSeconds)).ToList(),
            HookEntryShape.CodexGroups,
            HookShell.CmdUnquoted)
        {
            Description = "Codex hooks",
        },
        hookExePath,
        time);

    public string ConfigPath => hooksPath;

    /// <summary>False when the hook exe path has spaces and no 8.3 short form: the quoted command is written, but Codex will not run it.</summary>
    public bool CommandRunsOnWindows => _hooks.CommandRunsOnWindows;

    /// <summary>Same command for <c>command</c> and <c>commandWindows</c>; unquoted whenever the path allows it.</summary>
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
            return new HookStatus(HookInstallState.InvalidConfig, hooksPath);
        }

        var state = GetState(root);
        return new HookStatus(state, hooksPath)
        {
            NeedsApproval = state != HookInstallState.Missing && !AllTrusted(root),
        };
    }

    public string? Install() => _hooks.Install();

    public string? Uninstall() => _hooks.Uninstall();

    public IReadOnlyList<string> ReferencedHookExes() => _hooks.ReferencedHookExes();

    public HookInstallState GetState(JsonObject root) => _hooks.GetState(root);

    /// <summary>Every Kotilo handler has a trust entry in config.toml (keys use the absolute hooks.json path).</summary>
    private bool AllTrusted(JsonObject root)
    {
        var trusted = CodexTrustScanner.TrustedKeys(configTomlPath);
        var file = CodexTrustScanner.Normalize(Path.GetFullPath(hooksPath));
        return _hooks.OwnHandlerPositions(root).All(h =>
            trusted.Contains(string.Create(CultureInfo.InvariantCulture, $"{file}:{h.Event}:{h.Group}:{h.Index}")));
    }
}

/// <summary>
/// Read-only, tolerant scan of Codex's <c>config.toml</c> for hook trust entries: <c>[hooks.state."&lt;key&gt;"]</c>
/// tables (or <c>"&lt;key&gt;" = { … }</c> lines under <c>[hooks.state]</c>) that set <c>trusted_hash</c>. Not a TOML
/// parser; it only has to recognize what Codex writes, and a miss just reports "needs approval".
/// </summary>
public static class CodexTrustScanner
{
    public static HashSet<string> TrustedKeys(string configTomlPath)
    {
        var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string[] lines;
        try
        {
            if (!File.Exists(configTomlPath))
            {
                return keys;
            }

            lines = File.ReadAllLines(configTomlPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return keys;
        }

        string? table = null;
        var inStateTable = false;
        foreach (var raw in lines)
        {
            var line = raw.Trim();
            if (line.StartsWith('['))
            {
                table = null;
                inStateTable = line == "[hooks.state]";
                const string prefix = "[hooks.state.";
                if (line.StartsWith(prefix, StringComparison.Ordinal) && line.EndsWith(']'))
                {
                    table = ReadKey(line[prefix.Length..^1]);
                }

                continue;
            }

            if (table is not null && line.StartsWith("trusted_hash", StringComparison.Ordinal))
            {
                keys.Add(Normalize(table));
            }
            else if (inStateTable && (line.StartsWith('"') || line.StartsWith('\'')) && line.Contains("trusted_hash", StringComparison.Ordinal))
            {
                var end = line.IndexOf('=', StringComparison.Ordinal);
                if (end > 0 && ReadKey(line[..end].Trim()) is { } key)
                {
                    keys.Add(Normalize(key));
                }
            }
        }

        return keys;
    }

    /// <summary>A TOML quoted key: basic <c>"…"</c> (with <c>\\</c> and <c>\"</c> escapes) or literal <c>'…'</c>.</summary>
    internal static string? ReadKey(string text)
    {
        text = text.Trim();
        if (text.Length >= 2 && text[0] == '\'' && text[^1] == '\'')
        {
            return text[1..^1];
        }

        if (text.Length < 2 || text[0] != '"' || text[^1] != '"')
        {
            return null;
        }

        var sb = new StringBuilder();
        for (var i = 1; i < text.Length - 1; i++)
        {
            if (text[i] == '\\' && i + 1 < text.Length - 1)
            {
                i++;
                sb.Append(text[i] switch { 'n' => '\n', 't' => '\t', var c => c });
            }
            else
            {
                sb.Append(text[i]);
            }
        }

        return sb.ToString();
    }

    /// <summary>Slash direction may differ between how Codex and Kotilo spell the hooks.json path.</summary>
    internal static string Normalize(string key) => key.Replace('/', '\\');
}
