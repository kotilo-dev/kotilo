using System.Text.Json;
using System.Text.RegularExpressions;
using Hub.Core.Hooks;

namespace Hub.Core.Adapters;

/// <summary>Where an adapter definition comes from (ARCHITECTURE §3a): shipped with the app, or the user's own folder.</summary>
public enum AdapterSource
{
    BuiltIn,
    User,
}

/// <summary>
/// Command form an agent's Windows hook runner needs (adapter.json <c>hooks.shell</c>). Off Windows every form except
/// <see cref="Cmd"/> is a POSIX shell command (path single-quoted when needed); <see cref="Cmd"/>'s form is valid sh as is.
/// </summary>
public enum HookShell
{
    /// <summary><c>"C:\…\kotilo-hook.exe" --agent x --event Y</c> (cmd.exe; Claude Code, Droid).</summary>
    Cmd,

    /// <summary>No quotes; an 8.3 path when the path has spaces (cmd without verbatim arguments; Codex, Qwen, D-013).</summary>
    CmdUnquoted,

    /// <summary><c>&amp; 'C:\…\kotilo-hook.exe' --agent x --event Y</c> (Gemini, Copilot's <c>powershell</c> field).</summary>
    PowerShell,

    /// <summary>Shell-neutral: an unquoted forward-slash path without spaces (Cursor: cmd, PowerShell or bash).</summary>
    Any,
}

/// <summary>adapter.json <c>usage</c>: where token usage comes from.</summary>
public enum UsageMode
{
    None,
    BuiltIn,
    Protocol,
}

/// <summary>State a screen rule reports while it matches (adapter.json <c>screenRules[].state</c>).</summary>
public enum ScreenRuleState
{
    WaitingPermission,
    WaitingInput,
    Working,
    Done,
}

/// <summary>One data-driven prompt detector; the desktop app evaluates it against the pane's visible screen.</summary>
/// <param name="Lines">Visible lines from the bottom the pattern sees (1..50, default 6).</param>
/// <param name="ClearOn"><c>output</c>, <c>input</c>, or null (the state lasts while the rule matches).</param>
public sealed record ScreenRule(string Id, ScreenRuleState State, string Pattern, int Lines, string? ClearOn)
{
    public const int DefaultLines = 6;
}

/// <summary>adapter.json <c>hooks</c>: informational for built-in adapters (the installer is the source of truth).</summary>
public sealed record AdapterHooksInfo(HookShell Shell, IReadOnlyList<string> Events);

/// <summary>
/// A parsed, validated <c>adapter.json</c> (schema/adapter.v1.json). <see cref="Json"/> is the file as written, for
/// clients that need the fields the hub does not interpret (avatar, detect, launch, keys).
/// </summary>
public sealed partial record AdapterDefinition(string Id, string DisplayName, JsonElement Json)
{
    private static readonly TimeSpan RegexCheckTimeout = TimeSpan.FromMilliseconds(200);

    public AdapterHooksInfo? Hooks { get; init; }

    public UsageMode Usage { get; init; } = UsageMode.None;

    public IReadOnlyList<ScreenRule> ScreenRules { get; init; } = [];

    /// <summary>
    /// Parses and validates one definition. Returns null with at least one error when the text is not JSON, does not
    /// match the schema, or has a screen-rule pattern the desktop's regex engine can't run.
    /// </summary>
    public static AdapterDefinition? Parse(string json, JsonElement schema, out IReadOnlyList<string> errors)
    {
        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 32 });
            root = doc.RootElement.Clone();
        }
        catch (JsonException ex)
        {
            errors = [$"Not valid JSON: {ex.Message}"];
            return null;
        }

        var list = JsonSchemaLite.Validate(root, schema).ToList();
        if (list.Count > 0)
        {
            errors = list;
            return null;
        }

        var rules = new List<ScreenRule>();
        if (root.TryGetProperty("screenRules", out var rulesJson))
        {
            foreach (var r in rulesJson.EnumerateArray())
            {
                var id = r.GetProperty("id").GetString()!;
                var pattern = r.GetProperty("pattern").GetString()!;
                if (PatternError(pattern) is { } error)
                {
                    list.Add($"$.screenRules['{id}'].pattern: {error}");
                }

                rules.Add(new ScreenRule(
                    id,
                    Enum.Parse<ScreenRuleState>(r.GetProperty("state").GetString()!, ignoreCase: true),
                    pattern,
                    JsonFields.GetInt(r, "lines") ?? ScreenRule.DefaultLines,
                    JsonFields.GetString(r, "clearOn")));
            }
        }

        var duplicate = rules.GroupBy(r => r.Id, StringComparer.Ordinal).FirstOrDefault(g => g.Count() > 1);
        if (duplicate is not null)
        {
            list.Add($"$.screenRules: duplicate id '{duplicate.Key}'");
        }

        errors = list;
        if (list.Count > 0)
        {
            return null;
        }

        AdapterHooksInfo? hooks = null;
        if (root.TryGetProperty("hooks", out var h))
        {
            hooks = new AdapterHooksInfo(
                Enum.Parse<HookShell>(h.GetProperty("shell").GetString()!, ignoreCase: true),
                h.GetProperty("events").EnumerateArray().Select(e => e.GetString()!).ToList());
        }

        return new AdapterDefinition(root.GetProperty("id").GetString()!, root.GetProperty("displayName").GetString()!, root)
        {
            Hooks = hooks,
            Usage = JsonFields.GetString(root, "usage") is { } usage ? Enum.Parse<UsageMode>(usage, ignoreCase: true) : UsageMode.None,
            ScreenRules = rules,
        };
    }

    /// <summary>
    /// Screen rules run in the desktop app's Rust <c>regex</c> engine: the pattern must compile and stay out of
    /// lookaround and backreferences, which that engine doesn't have. .NET compiles it as a sanity check.
    /// </summary>
    internal static string? PatternError(string pattern)
    {
        if (UnsupportedSyntax().IsMatch(pattern))
        {
            return "lookaround and backreferences are not supported";
        }

        try
        {
            _ = new Regex(pattern, RegexOptions.None, RegexCheckTimeout);
            return null;
        }
        catch (ArgumentException ex)
        {
            return "invalid regex: " + ex.Message;
        }
    }

    [GeneratedRegex(@"\(\?<?[=!]|\\[1-9]|\\k<")]
    private static partial Regex UnsupportedSyntax();
}
