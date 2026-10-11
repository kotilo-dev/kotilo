using System.Runtime.InteropServices;

namespace Hub.Infrastructure.Platform;

/// <summary>
/// Platform layer (AGENTS.md rule 7): paths for agent hook command lines that must not be quoted.
/// Codex runs Windows hooks as <c>cmd /C "&lt;command&gt;"</c> and a command containing quotes does not run
/// (verified with codex-cli 0.160.0, D-013), so a directory with spaces is replaced by its 8.3 short form.
/// The file name is kept long because it carries the <c>agenthub-hook</c> ownership marker.
/// </summary>
public static partial class CommandLinePaths
{
    /// <returns>A path without whitespace, or null when none exists (8.3 names disabled, or not Windows).</returns>
    public static string? WithoutSpaces(string path)
    {
        if (!path.Any(char.IsWhiteSpace))
        {
            return path;
        }

        if (!OperatingSystem.IsWindows())
        {
            return null;
        }

        var dir = Path.GetDirectoryName(path);
        if (dir is null)
        {
            return null;
        }

        var buffer = new char[1024];
        var length = GetShortPathNameW(dir, buffer, (uint)buffer.Length);
        if (length == 0 || length >= buffer.Length)
        {
            return null;
        }

        var shortened = Path.Combine(new string(buffer, 0, (int)length), Path.GetFileName(path));
        return shortened.Any(char.IsWhiteSpace) ? null : shortened;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern uint GetShortPathNameW(string lpszLongPath, [Out] char[] lpszShortPath, uint cchBuffer);
}
