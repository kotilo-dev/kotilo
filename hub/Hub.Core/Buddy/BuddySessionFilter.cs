namespace Hub.Core.Buddy;

/// <summary>
/// Recognizes Bip's own Claude runs by working directory (spec §17.2): the buddy folder or anything below it. Such
/// sessions stay out of the session list, notifications, tray / mascot state and project discovery; their usage is
/// reported separately as "Buddy".
/// </summary>
public sealed class BuddySessionFilter(string buddyDir)
{
    private readonly string _root = Normalize(buddyDir);

    public string BuddyDir { get; } = buddyDir;

    public bool IsBuddy(string? cwd)
    {
        if (string.IsNullOrWhiteSpace(cwd))
        {
            return false;
        }

        var path = Normalize(cwd);
        return path.Equals(_root, StringComparison.OrdinalIgnoreCase)
            || path.StartsWith(_root + "\\", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// A transcript under <c>~/.claude/projects/&lt;encoded buddy folder&gt;/</c>. Claude Code names the folder by replacing
    /// every character that is not a letter or digit with <c>-</c>.
    /// </summary>
    public bool IsBuddyTranscript(string transcriptPath)
    {
        var folder = Path.GetFileName(Path.GetDirectoryName(transcriptPath));
        return folder is not null && folder.StartsWith(_encoded, StringComparison.OrdinalIgnoreCase);
    }

    private readonly string _encoded = string.Concat(Normalize(buddyDir).Select(c => char.IsAsciiLetterOrDigit(c) ? c : '-'));

    private static string Normalize(string path) => path.Replace('/', '\\').TrimEnd('\\');
}
