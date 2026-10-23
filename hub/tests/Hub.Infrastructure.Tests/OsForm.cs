namespace Hub.Infrastructure.Tests;

/// <summary>
/// Hook command lines differ by OS (<c>Platform/HookCommandLine</c>): the cmd / PowerShell forms on Windows, the POSIX
/// shell form elsewhere, where the Windows-style test paths (backslashes) are single-quoted.
/// </summary>
internal static class OsForm
{
    public static T Pick<T>(T windows, T posix) => OperatingSystem.IsWindows() ? windows : posix;
}
