using System.Text;
using System.Text.RegularExpressions;

namespace Hub.Core.Projects;

/// <summary>
/// Project-relative file glob for todo files (spec §8.2, default <c>tasks/**/*.md</c>). Supports <c>**</c> (any number of
/// folders), <c>*</c> and <c>?</c> within one segment. Matching is case-insensitive and accepts both slash kinds.
/// </summary>
public sealed class GlobPattern
{
    public const string Default = "tasks/**/*.md";

    private readonly Regex _regex;

    private GlobPattern(string pattern, string baseDirectory, Regex regex)
    {
        Pattern = pattern;
        BaseDirectory = baseDirectory;
        _regex = regex;
    }

    public string Pattern { get; }

    /// <summary>The leading wildcard-free folders (<c>tasks</c> for the default): the only place a scan needs to start.</summary>
    public string BaseDirectory { get; }

    public static GlobPattern Parse(string? pattern)
    {
        var normalized = Normalize(string.IsNullOrWhiteSpace(pattern) ? Default : pattern.Trim()).Trim('/');
        var segments = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries);

        var literal = segments.TakeWhile(s => s.IndexOfAny(['*', '?']) < 0).ToList();
        if (literal.Count == segments.Length)
        {
            // A plain file path: its folder is the base.
            literal.RemoveAt(literal.Count - 1);
        }

        var regex = new StringBuilder("^");
        for (var i = 0; i < segments.Length; i++)
        {
            var last = i == segments.Length - 1;
            if (segments[i] == "**")
            {
                regex.Append(last ? ".*" : "(?:[^/]+/)*");
                continue;
            }

            foreach (var c in segments[i])
            {
                regex.Append(c switch
                {
                    '*' => "[^/]*",
                    '?' => "[^/]",
                    _ => Regex.Escape(c.ToString()),
                });
            }

            if (!last)
            {
                regex.Append('/');
            }
        }

        regex.Append('$');
        return new GlobPattern(
            normalized,
            string.Join('/', literal),
            new Regex(regex.ToString(), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100)));
    }

    /// <param name="relativePath">Path relative to the project root.</param>
    public bool IsMatch(string relativePath) => _regex.IsMatch(Normalize(relativePath).TrimStart('/'));

    private static string Normalize(string path) => path.Replace('\\', '/');
}
