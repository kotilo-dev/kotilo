using System.Text.RegularExpressions;

namespace Hub.Infrastructure.Platform;

/// <summary>What to start for an agent CLI: the file plus arguments that go before the CLI's own.</summary>
public sealed record CliLaunchPlan(string FileName, IReadOnlyList<string> PrefixArguments);

/// <summary>
/// Platform layer (AGENTS.md rule 7): executable names and how a CLI is started. On Windows npm installs CLIs as
/// <c>.cmd</c> shims; cmd.exe expands <c>%VAR%</c> and splits on quotes inside arguments, so free text (a prompt, a
/// system prompt) never goes through it. The shim's target (a native exe, or node + script) is started directly instead;
/// only arguments from a small safe character set may fall back to <c>cmd /d /c</c>.
/// </summary>
public static partial class CliLaunch
{
    /// <summary>File names for a base name, in preference order.</summary>
    public static IReadOnlyList<string> FileNames(string baseName) =>
        OperatingSystem.IsWindows() ? [baseName + ".exe", baseName + ".cmd"] : [baseName];

    /// <summary>
    /// Expands <c>%USERPROFILE%</c>, <c>%APPDATA%</c> and <c>%LOCALAPPDATA%</c>: the real folders, or folders below
    /// <paramref name="userProfile"/> when one is given (tests).
    /// </summary>
    public static string ExpandKnownDir(string dir, string? userProfile = null)
    {
        var profile = userProfile ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var appData = userProfile is null
            ? Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData)
            : Path.Combine(profile, "AppData", "Roaming");
        var localAppData = userProfile is null
            ? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
            : Path.Combine(profile, "AppData", "Local");
        if (!OperatingSystem.IsWindows())
        {
            // npm's global prefix and per-user installs live elsewhere on macOS; PATH covers them.
            appData = Path.Combine(profile, ".config");
            localAppData = Path.Combine(profile, ".local", "share");
        }

        return dir
            .Replace("%USERPROFILE%", profile, StringComparison.OrdinalIgnoreCase)
            .Replace("%LOCALAPPDATA%", localAppData, StringComparison.OrdinalIgnoreCase)
            .Replace("%APPDATA%", appData, StringComparison.OrdinalIgnoreCase)
            .Replace('\\', Path.DirectorySeparatorChar);
    }

    /// <returns>Null when <paramref name="executable"/> is a shim that cannot be resolved and the arguments are not cmd-safe.</returns>
    public static CliLaunchPlan? Plan(string executable, IReadOnlyList<string> arguments, string? pathVariable = null)
    {
        if (!IsBatch(executable))
        {
            return new CliLaunchPlan(executable, []);
        }

        if (ResolveNpmShim(executable, pathVariable) is { } target)
        {
            return target;
        }

        return arguments.All(IsCmdSafe) ? new CliLaunchPlan("cmd.exe", ["/d", "/c", executable]) : null;
    }

    public static bool IsBatch(string path) =>
        path.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".bat", StringComparison.OrdinalIgnoreCase);

    /// <summary>Letters, digits, space and <c>. _ , : / \ = + @ # - [ ] { }</c>: nothing cmd.exe expands or splits on.</summary>
    public static bool IsCmdSafe(string argument) => CmdSafeRegex().IsMatch(argument);

    /// <summary>
    /// Reads an npm cmd shim (<c>"%dp0%\node_modules\…\x.exe" %*</c> or <c>"%_prog%" "%dp0%\node_modules\…\cli.js" %*</c>).
    /// </summary>
    internal static CliLaunchPlan? ResolveNpmShim(string shimPath, string? pathVariable = null)
    {
        string text;
        try
        {
            var info = new FileInfo(shimPath);
            if (!info.Exists || info.Length > 16 * 1024)
            {
                return null;
            }

            text = File.ReadAllText(shimPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }

        var dir = Path.GetDirectoryName(shimPath) ?? "";
        foreach (Match m in ShimTargetRegex().Matches(text))
        {
            var target = Path.GetFullPath(Path.Combine(dir, m.Groups[1].Value));

            // `IF EXIST "%dp0%\node.exe"` names the interpreter, not the target.
            if (!File.Exists(target) || Path.GetFileName(target).Equals("node.exe", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            {
                return new CliLaunchPlan(target, []);
            }

            if (Path.GetExtension(target).ToLowerInvariant() is ".js" or ".mjs" or ".cjs")
            {
                var node = Path.Combine(dir, "node.exe");
                node = File.Exists(node) ? node : FindOnPath("node.exe", pathVariable);
                return node is null ? null : new CliLaunchPlan(node, [target]);
            }
        }

        return null;
    }

    private static string? FindOnPath(string fileName, string? pathVariable)
    {
        foreach (var dir in (pathVariable ?? Environment.GetEnvironmentVariable("PATH") ?? "")
                     .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                var candidate = Path.Combine(dir.Trim('"'), fileName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
            catch (ArgumentException)
            {
            }
        }

        return null;
    }

    [GeneratedRegex(@"^[A-Za-z0-9 ._,:/\\=+@#\-\[\]{}]*$")]
    private static partial Regex CmdSafeRegex();

    [GeneratedRegex("\"%~?dp0%?\\\\([^\"%]+)\"")]
    private static partial Regex ShimTargetRegex();
}
