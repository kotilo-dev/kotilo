namespace Hub.Infrastructure.Platform;

/// <summary>Platform layer (AGENTS.md rule 7): per-user folders shared with the desktop app.</summary>
public static class UserFolders
{
    /// <summary>
    /// The desktop app's settings root (its <c>roaming_data_root</c>): <c>%APPDATA%</c> on Windows,
    /// <c>~/Library/Application Support</c> on macOS, <c>$XDG_CONFIG_HOME</c> or <c>~/.config</c> elsewhere.
    /// .NET's <c>ApplicationData</c> is <c>~/.config</c> on macOS too, so macOS takes <c>LocalApplicationData</c>.
    /// </summary>
    public static string Roaming => Environment.GetFolderPath(
        OperatingSystem.IsMacOS() ? Environment.SpecialFolder.LocalApplicationData : Environment.SpecialFolder.ApplicationData);
}
