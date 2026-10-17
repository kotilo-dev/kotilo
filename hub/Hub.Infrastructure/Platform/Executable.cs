namespace Hub.Infrastructure.Platform;

/// <summary>Platform layer (AGENTS.md rule 7): executable file names, <c>name.exe</c> on Windows and <c>name</c> elsewhere.</summary>
public static class Executable
{
    public static string Suffix => OperatingSystem.IsWindows() ? ".exe" : string.Empty;

    public static string Name(string stem) => stem + Suffix;
}
