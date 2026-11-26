using System.Text.RegularExpressions;

namespace Hub.Core.Watch;

/// <summary>A built-in rule: fixed id and English name, matched by code (some need more than one regex).</summary>
public sealed record BuiltinWatchRule(string Id, string Name, bool Notify, Func<WatchInput, bool> Matches);

/// <summary>
/// The built-in watch rules (<c>builtin.*</c>). Kept narrow so they stay quiet: <c>.env.example</c>, <c>--force-with-lease</c>
/// and <c>rm -rf node_modules</c> do not match. Command patterns use the same non-backtracking engine and time limit as
/// user rules; a timeout is handled by <see cref="WatchEngine"/>.
/// </summary>
public static class WatchBuiltins
{
    public const string SecretFile = "builtin.secret-file";
    public const string ForcePush = "builtin.force-push";
    public const string GitDiscard = "builtin.git-discard";
    public const string WideDelete = "builtin.wide-delete";
    public const string DbDrop = "builtin.db-drop";
    public const string PipeToShell = "builtin.pipe-to-shell";

    private const RegexOptions Options = RegexOptions.NonBacktracking | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;

    // "git", then global options (-C dir, --no-pager, -c k=v) up to the subcommand.
    private const string GitPrefix = @"(?:^|[\s;&|(/\\])git(?:\.exe)?(?:\s+-{1,2}[A-Za-z][\w-]*(?:=\S+)?(?:\s+[^\s-]\S*)?)*";

    private static readonly Regex ForcePushPattern = Create(
        GitPrefix + @"\s+push\b[^;&|\n]*\s(?:(?:--force|-[A-Za-z]*f[A-Za-z]*)(?:\s|$)|\+[^\s+])");

    private static readonly Regex GitDiscardPattern = Create(
        GitPrefix + @"\s+reset\b(?:[^;&|\n]*\s)?--hard(?:\s|$)|" + GitPrefix + @"\s+clean\b[^;&|\n]*\s(?:--force|-[A-Za-z]*f[A-Za-z]*)(?:\s|$)");

    private static readonly Regex DbDropPattern = Create(
        @"\bDROP\s+(?:TABLE|DATABASE)\b|\bTRUNCATE\s+(?:TABLE\s+)?[\w.""'\[\]`]+\s*(?:[;,""')]|$)");

    private static readonly Regex PipeToShellPattern = Create(
        @"\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(?:sudo\s+)?(?:(?:ba|z|da|k)?sh|iex|Invoke-Expression|pwsh|powershell)\b"
        + @"|\b(?:iex|Invoke-Expression)\b[^\n]*\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|curl|wget)\b"
        + @"|\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b");

    private static readonly char[] CommandSeparators = [' ', '\t', '\r', '\n', '"', '\'', '<', '>', '=', ',', ';', '(', ')', '|', '&', '`'];

    private static readonly char[] SegmentSeparators = [';', '&', '|', '\n', '\r'];

    /// <summary>All built-ins in display order.</summary>
    public static IReadOnlyList<BuiltinWatchRule> All { get; } =
    [
        new(SecretFile, "Secret file", true, MatchesSecretFile),
        new(ForcePush, "Force push", true, i => IsMatch(ForcePushPattern, i.Command)),
        new(GitDiscard, "Irreversible git command", false, i => IsMatch(GitDiscardPattern, i.Command)),
        new(WideDelete, "Wide delete", true, i => i.Command is { } c && IsWideDelete(c)),
        new(DbDrop, "Database drop", true, i => IsMatch(DbDropPattern, i.Command)),
        new(PipeToShell, "Download and run", true, i => IsMatch(PipeToShellPattern, i.Command)),
    ];

    public static bool IsBuiltinId(string id) => id.StartsWith("builtin.", StringComparison.Ordinal);

    private static Regex Create(string pattern) => new(pattern, Options, WatchLimits.RegexTimeout);

    private static bool IsMatch(Regex pattern, string? command) => !string.IsNullOrEmpty(command) && pattern.IsMatch(command);

    // ---- secret files ----

    private static bool MatchesSecretFile(WatchInput i)
    {
        if (i.Path is { } p && IsSecretFileName(LastSegment(p)))
        {
            return true;
        }

        if (i.Paths is { } paths && paths.Any(x => IsSecretFileName(LastSegment(x))))
        {
            return true;
        }

        // A command that names one (cat .env, cp key.pem x): look at every word's file name.
        return i.Command is { } c && c.Split(CommandSeparators, StringSplitOptions.RemoveEmptyEntries).Any(w => IsSecretFileName(LastSegment(w), command: w.IndexOfAny(['/', '\\']) < 0));
    }

    private static string LastSegment(string path) => path[(path.LastIndexOfAny(['/', '\\']) + 1)..];

    /// <summary>Key and certificate extensions only count for paths (or a command word that has a directory part): a bare `.key` in a command (`jq .key`, `d.key`) is code, not a file.</summary>
    internal static bool IsSecretFileName(string name, bool command = false)
    {
        var n = name.ToLowerInvariant();
        if (n == ".env" || n.StartsWith(".env*", StringComparison.Ordinal))
        {
            return true;
        }

        if (n.StartsWith(".env.", StringComparison.Ordinal))
        {
            return !(n.EndsWith(".example", StringComparison.Ordinal) || n.EndsWith(".sample", StringComparison.Ordinal) || n.EndsWith(".template", StringComparison.Ordinal));
        }

        if (!command && (n.EndsWith(".pem", StringComparison.Ordinal) || n.EndsWith(".key", StringComparison.Ordinal)))
        {
            return true;
        }

        // The public half (id_rsa.pub) is not a secret.
        return (n.StartsWith("id_rsa", StringComparison.Ordinal) || n.StartsWith("id_ed25519", StringComparison.Ordinal))
            && !n.EndsWith(".pub", StringComparison.Ordinal);
    }

    // ---- wide delete ----

    /// <summary><c>rm -rf</c> / <c>Remove-Item -Recurse -Force</c> whose target is absolute, <c>~</c>, <c>..</c> or <c>/</c>.</summary>
    internal static bool IsWideDelete(string command)
    {
        foreach (var segment in command.Split(SegmentSeparators, StringSplitOptions.RemoveEmptyEntries))
        {
            var tokens = segment.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries).Select(Unquote).ToArray();
            for (var i = 0; i < tokens.Length; i++)
            {
                var name = LastSegment(tokens[i]).ToLowerInvariant();
                if (name is not ("rm" or "remove-item" or "ri"))
                {
                    continue;
                }

                bool recursive = false, force = false, wide = false, skipNext = false;
                foreach (var token in tokens.Skip(i + 1))
                {
                    if (skipNext)
                    {
                        skipNext = false;
                        continue;
                    }

                    // A redirect (> f, 2>/dev/null, < f) is not a delete target; its file is the next token.
                    if (token.AsSpan().IndexOfAny('>', '<') >= 0)
                    {
                        skipNext = token.TrimEnd().EndsWith('>') || token.EndsWith('<');
                        continue;
                    }

                    if (token.Length > 1 && token[0] == '-')
                    {
                        var flag = ClassifyFlag(token, unixRm: name == "rm");
                        recursive |= flag.Recursive;
                        force |= flag.Force;
                    }
                    else if (IsWideTarget(token))
                    {
                        wide = true;
                    }
                }

                if (recursive && force && wide)
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static (bool Recursive, bool Force) ClassifyFlag(string token, bool unixRm)
    {
        var f = token.ToLowerInvariant();
        if (f == "--recursive")
        {
            return (true, false);
        }

        if (f == "--force")
        {
            return (false, true);
        }

        if (f.StartsWith("--", StringComparison.Ordinal))
        {
            return (false, false);
        }

        // PowerShell parameters, abbreviations allowed: -Recurse (-rec…) and -Force (-fo…).
        if (f.Length >= 4 && "-recurse".StartsWith(f, StringComparison.Ordinal))
        {
            return (true, false);
        }

        if (f.Length >= 3 && "-force".StartsWith(f, StringComparison.Ordinal))
        {
            return (false, true);
        }

        // Unix short flags, possibly clustered (-rf, -fr, -Rf): only for rm, and only short ones (-ErrorAction is not a cluster).
        if (unixRm && f.Length <= 5 && f.Skip(1).All(c => c is 'r' or 'f' or 'v' or 'i' or 'd'))
        {
            return (f.Contains('r'), f.Contains('f'));
        }

        return (false, false);
    }

    private static bool IsWideTarget(string t)
    {
        if (t.Length == 0)
        {
            return false;
        }

        if (t[0] is '/' or '\\' or '~' || t == ".." || t.StartsWith("../", StringComparison.Ordinal) || t.StartsWith("..\\", StringComparison.Ordinal))
        {
            return true;
        }

        if (t.Length >= 3 && char.IsAsciiLetter(t[0]) && t[1] == ':' && t[2] is '/' or '\\')
        {
            return true;
        }

        return t.StartsWith("$HOME", StringComparison.OrdinalIgnoreCase) || t.StartsWith("${HOME}", StringComparison.OrdinalIgnoreCase)
            || t.StartsWith("$env:USERPROFILE", StringComparison.OrdinalIgnoreCase) || t.StartsWith("$env:HOME", StringComparison.OrdinalIgnoreCase)
            || t.StartsWith("%USERPROFILE%", StringComparison.OrdinalIgnoreCase);
    }

    private static string Unquote(string token) => token.Trim('"', '\'', '`');
}
