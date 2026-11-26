using System.Text.RegularExpressions;
using Hub.Core.Activity;
using Hub.Core.Projects;

namespace Hub.Core.Watch;

/// <summary>A rule ready to run. <see cref="Matches"/> may throw <see cref="RegexMatchTimeoutException"/>; <see cref="WatchEngine"/> handles it.</summary>
public sealed class CompiledWatchRule(string id, string name, bool notify, Func<WatchInput, bool> matches)
{
    public string Id { get; } = id;

    public string Name { get; } = name;

    public bool Notify { get; } = notify;

    public Func<WatchInput, bool> Matches { get; } = matches;
}

/// <summary>Validates a <see cref="WatchRule"/> and turns it into a <see cref="CompiledWatchRule"/>.</summary>
public static partial class WatchRuleCompiler
{
    [GeneratedRegex("^[a-z0-9._-]+$")]
    private static partial Regex IdPattern();

    /// <summary>Control characters removed, trimmed.</summary>
    public static string CleanName(string? name) =>
        string.Concat((name ?? string.Empty).Where(c => !char.IsControl(c))).Trim();

    /// <summary>1-64 characters of a-z 0-9 . _ -.</summary>
    public static bool IsValidId(string? id) => id is { Length: >= 1 and <= WatchLimits.MaxIdLength } && IdPattern().IsMatch(id);

    private static bool IsValidPrefixedId(string? id, string prefix) =>
        id is not null && id.StartsWith(prefix, StringComparison.Ordinal) && IsValidId(id[prefix.Length..]);

    /// <summary>
    /// Checks <paramref name="rule"/>; <paramref name="requiredIdPrefix"/> (<c>user.</c>) must start its id when given.
    /// Returns per-field messages (never containing the rule's text); <paramref name="compiled"/> is set only when there are none.
    /// </summary>
    public static IReadOnlyList<(string Field, string Message)> Compile(
        WatchRule rule, string? requiredIdPrefix, TimeSpan timeout, out CompiledWatchRule? compiled)
    {
        compiled = null;
        var errors = new List<(string, string)>();

        if (requiredIdPrefix is null ? !IsValidId(rule.Id) : !IsValidPrefixedId(rule.Id, requiredIdPrefix))
        {
            errors.Add(("id", requiredIdPrefix is null ? "1-64 characters: a-z 0-9 . _ -" : $"must start with \"{requiredIdPrefix}\" (a-z 0-9 . _ -, at most 64 characters)"));
        }

        var name = CleanName(rule.Name);
        if (name.Length == 0 || name.Length > WatchLimits.MaxNameLength)
        {
            errors.Add(("name", $"1-{WatchLimits.MaxNameLength} characters"));
        }

        var tools = Items(rule.Tools, "tools", errors);
        var paths = Items(rule.Paths, "paths", errors);
        var command = string.IsNullOrWhiteSpace(rule.Command) ? null : rule.Command;

        if (tools is null && paths is null && command is null && errors.All(e => e.Item1 is not ("tools" or "paths")))
        {
            errors.Add(("match", "at least one of tools, command or paths is required"));
        }

        Regex? regex = null;
        if (command is not null)
        {
            if (command.Length > WatchLimits.MaxRegexLength)
            {
                errors.Add(("command", $"at most {WatchLimits.MaxRegexLength} characters"));
            }
            else
            {
                try
                {
                    regex = new Regex(command, RegexOptions.NonBacktracking | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, timeout);
                }
                catch (NotSupportedException)
                {
                    errors.Add(("command", "uses a regex feature that is not supported (lookarounds, backreferences, atomic groups)"));
                }
                catch (ArgumentException)
                {
                    errors.Add(("command", "is not a valid regular expression"));
                }
            }
        }

        if (errors.Count > 0)
        {
            return errors;
        }

        var toolSet = tools?.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var globs = paths?.Select(p => GlobPattern.Parse(p)).ToList();
        compiled = new CompiledWatchRule(rule.Id, name, rule.Notify, input => Matches(input, toolSet, regex, globs));
        return errors;
    }

    private static List<string>? Items(IReadOnlyList<string>? list, string field, List<(string, string)> errors)
    {
        if (list is null || list.Count == 0)
        {
            return null;
        }

        if (list.Count > WatchLimits.MaxListItems || list.Any(x => string.IsNullOrWhiteSpace(x) || x.Length > WatchLimits.MaxItemLength))
        {
            errors.Add((field, $"at most {WatchLimits.MaxListItems} non-empty items of at most {WatchLimits.MaxItemLength} characters"));
            return null;
        }

        return list.Select(x => x.Trim()).ToList();
    }

    private static bool Matches(WatchInput input, HashSet<string>? tools, Regex? regex, List<GlobPattern>? globs)
    {
        if (tools is not null && (input.Tool is null || !tools.Contains(input.Tool)))
        {
            return false;
        }

        if (regex is not null && (string.IsNullOrEmpty(input.Command) || !regex.IsMatch(input.Command)))
        {
            return false;
        }

        return globs is null || PathMatches(input, globs);
    }

    private static bool PathMatches(WatchInput input, List<GlobPattern> globs)
    {
        var candidates = new List<string>();
        if (input.Path is not null)
        {
            candidates.Add(input.Path);
        }

        if (input.Paths is not null)
        {
            candidates.AddRange(input.Paths);
        }

        foreach (var path in candidates)
        {
            var relative = ActivityTracker.RelativeTo(path, input.Root);
            if (globs.Any(g => g.IsMatch(relative) || g.IsMatch(path)))
            {
                return true;
            }
        }

        return false;
    }
}
