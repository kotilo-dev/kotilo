using System.Text.Json;

namespace Hub.Core.Watch;

/// <summary>Reads the rules of a project's <c>.kotilo/watch.json</c> (<c>{ "rules": [ … ] }</c>). Pure: the caller checks size and reads the file.</summary>
public static class WatchProjectFileParser
{
    public const string ProjectIdPrefix = "project.";

    private static readonly JsonDocumentOptions DocumentOptions = new() { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true, MaxDepth = 16 };

    public static ProjectWatchFile Parse(string root, string json, TimeSpan regexTimeout)
    {
        var problems = new List<WatchProblem>();
        var rules = new List<WatchRule>();

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(json, DocumentOptions);
        }
        catch (JsonException ex)
        {
            problems.Add(new WatchProblem(null, "The file is not valid JSON.", ex.LineNumber is { } line ? (int)line + 1 : null));
            return new ProjectWatchFile(root, rules, problems);
        }

        using (doc)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("rules", out var list) || list.ValueKind != JsonValueKind.Array)
            {
                problems.Add(new WatchProblem(null, "Expected an object with a \"rules\" array."));
                return new ProjectWatchFile(root, rules, problems);
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            var index = 0;
            foreach (var element in list.EnumerateArray())
            {
                index++;
                if (index > WatchLimits.MaxProjectRules)
                {
                    problems.Add(new WatchProblem(null, $"Only the first {WatchLimits.MaxProjectRules} rules are used."));
                    break;
                }

                var raw = ReadRule(element);

                if (raw is null)
                {
                    problems.Add(new WatchProblem(null, $"Rule {index} is not a rule object, or one of its fields has the wrong type."));
                    continue;
                }

                var rawId = raw.Id ?? string.Empty;
                if (!WatchRuleCompiler.IsValidId(rawId))
                {
                    problems.Add(new WatchProblem(null, $"Rule {index}: id must be 1-64 characters of a-z 0-9 . _ -."));
                    continue;
                }

                var forced = raw with { Id = ProjectIdPrefix + rawId, Name = WatchRuleCompiler.CleanName(raw.Name) };
                if (!seen.Add(forced.Id))
                {
                    problems.Add(new WatchProblem(forced.Id, "Duplicate rule id."));
                    continue;
                }

                var errors = WatchRuleCompiler.Compile(forced, ProjectIdPrefix, regexTimeout, out _);
                if (errors.Count > 0)
                {
                    problems.Add(new WatchProblem(forced.Id, string.Join("; ", errors.Select(e => $"{e.Field}: {e.Message}"))));
                    continue;
                }

                rules.Add(forced);
            }
        }

        return new ProjectWatchFile(root, rules, problems);
    }

    /// <summary>Null when the element is not an object or a field has the wrong type.</summary>
    private static WatchRule? ReadRule(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        string? id = null, name = null, command = null;
        bool enabled = true, notify = true;
        IReadOnlyList<string>? tools = null, paths = null;
        foreach (var p in element.EnumerateObject())
        {
            switch (p.Name.ToLowerInvariant())
            {
                case "id":
                    if (p.Value.ValueKind != JsonValueKind.String)
                    {
                        return null;
                    }

                    id = p.Value.GetString();
                    break;
                case "name":
                    if (p.Value.ValueKind != JsonValueKind.String)
                    {
                        return null;
                    }

                    name = p.Value.GetString();
                    break;
                case "command":
                    if (p.Value.ValueKind != JsonValueKind.String)
                    {
                        return null;
                    }

                    command = p.Value.GetString();
                    break;
                case "enabled":
                    if (p.Value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    {
                        return null;
                    }

                    enabled = p.Value.GetBoolean();
                    break;
                case "notify":
                    if (p.Value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    {
                        return null;
                    }

                    notify = p.Value.GetBoolean();
                    break;
                case "tools":
                    tools = ReadStrings(p.Value);
                    if (tools is null)
                    {
                        return null;
                    }

                    break;
                case "paths":
                    paths = ReadStrings(p.Value);
                    if (paths is null)
                    {
                        return null;
                    }

                    break;
                default:
                    break;
            }
        }

        return new WatchRule(id ?? string.Empty, name ?? string.Empty, enabled, notify, tools, command, paths);
    }

    private static List<string>? ReadStrings(JsonElement e)
    {
        if (e.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var list = new List<string>();
        foreach (var item in e.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            list.Add(item.GetString() ?? string.Empty);
        }

        return list;
    }
}
