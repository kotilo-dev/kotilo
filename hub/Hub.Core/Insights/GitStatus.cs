using System.Globalization;

namespace Hub.Core.Insights;

/// <summary>Git state of one project root (spec §18.3). Only metadata; the commit subject is the user's own text.</summary>
/// <param name="Branch">Branch name; null when detached.</param>
/// <param name="HasUpstream">False when no upstream is set: <see cref="Ahead"/> / <see cref="Behind"/> are then 0.</param>
/// <param name="Changed">Staged + unstaged + untracked + conflicted entries.</param>
public sealed record GitStatus(
    string? Branch,
    bool IsDetached,
    bool HasUpstream,
    int Ahead,
    int Behind,
    int Changed,
    DateTimeOffset? LastCommitAt,
    string? LastCommitSubject,
    DateTimeOffset CheckedAt);

/// <summary>Parses <c>git status --porcelain=v2 --branch</c> and <c>git log -1 --format=%ct%x09%s</c>.</summary>
public static class GitStatusParser
{
    public static GitStatus Parse(string statusOutput, string? logOutput, DateTimeOffset checkedAt)
    {
        string? branch = null;
        var detached = false;
        var upstream = false;
        int ahead = 0, behind = 0, changed = 0;

        foreach (var raw in statusOutput.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.StartsWith("# branch.head ", StringComparison.Ordinal))
            {
                var head = line["# branch.head ".Length..];
                detached = head == "(detached)";
                branch = detached ? null : head;
            }
            else if (line.StartsWith("# branch.upstream ", StringComparison.Ordinal))
            {
                upstream = true;
            }
            else if (line.StartsWith("# branch.ab ", StringComparison.Ordinal))
            {
                var parts = line["# branch.ab ".Length..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
                foreach (var p in parts)
                {
                    if (p.Length > 1 && int.TryParse(p.AsSpan(1), NumberStyles.None, CultureInfo.InvariantCulture, out var n))
                    {
                        if (p[0] == '+')
                        {
                            ahead = n;
                        }
                        else if (p[0] == '-')
                        {
                            behind = n;
                        }
                    }
                }
            }
            else if (line.Length > 1 && line[1] == ' ' && line[0] is '1' or '2' or 'u' or '?')
            {
                changed++;
            }
        }

        DateTimeOffset? at = null;
        string? subject = null;
        if (logOutput?.Trim('\r', '\n') is { Length: > 0 } log)
        {
            var tab = log.IndexOf('\t', StringComparison.Ordinal);
            var epochText = tab >= 0 ? log[..tab] : log;
            if (long.TryParse(epochText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var epoch))
            {
                at = DateTimeOffset.FromUnixTimeSeconds(epoch);
            }

            subject = tab >= 0 ? log[(tab + 1)..].Split('\n')[0].TrimEnd('\r') : null;
        }

        return new GitStatus(branch, detached, upstream, upstream ? ahead : 0, upstream ? behind : 0, changed, at, subject, checkedAt);
    }
}
