namespace Hub.Core.Adapters;

public enum HookInstallState
{
    /// <summary>No Kotilo hook entry.</summary>
    Missing,

    /// <summary>Every required event points at the current hook exe.</summary>
    Installed,

    /// <summary>Some Kotilo entries exist but events are missing or the exe path differs.</summary>
    Outdated,

    /// <summary>The agent's config file can't be parsed; it is left untouched.</summary>
    InvalidConfig,

    /// <summary>The agent has no hook mechanism Kotilo can use.</summary>
    Unsupported,
}

/// <param name="ConfigPath">The agent config file the hooks live in.</param>
public sealed record HookStatus(HookInstallState State, string ConfigPath)
{
    /// <summary>Installed, but the agent still has to approve the hooks before running them (Codex <c>/hooks</c>).</summary>
    public bool NeedsApproval { get; init; }

    /// <summary>
    /// Why installed hooks may still stay silent, as a stable code for the UI; null when there is nothing to say.
    /// See <see cref="HookHints"/>.
    /// </summary>
    public string? Hint { get; init; }
}

/// <summary>Values of <see cref="HookStatus.Hint"/>.</summary>
public static class HookHints
{
    public const string FolderTrust = "folderTrust";

    /// <summary>The agent's own setting switches all hooks off (Gemini <c>hooksConfig.enabled: false</c>, Qwen <c>disableAllHooks</c>).</summary>
    public const string HooksDisabled = "hooksDisabled";
}

/// <summary>
/// Backup-first hook registration in one agent's config (AGENTS.md rule 4): only entries whose command runs agenthub-hook
/// are added or removed, and a file that can't be parsed is never rewritten.
/// </summary>
public interface IHookInstaller
{
    string ConfigPath { get; }

    /// <summary>Never throws for a bad config file: that is <see cref="HookInstallState.InvalidConfig"/>.</summary>
    HookStatus GetStatus();

    /// <summary>Installs or repairs our entries. Returns the backup path, or null if nothing changed.</summary>
    /// <exception cref="HookConfigException">The config file can't be parsed or has an unexpected shape.</exception>
    string? Install();

    /// <summary>Removes only our entries. Returns the backup path, or null if there was nothing to remove.</summary>
    /// <exception cref="HookConfigException">The config file can't be parsed or has an unexpected shape.</exception>
    string? Uninstall();

    /// <summary>Exe paths of every Kotilo command in the config (health check: they must still exist, spec §18.6).</summary>
    /// <exception cref="HookConfigException">The config file can't be parsed.</exception>
    IReadOnlyList<string> ReferencedHookExes();
}

/// <summary>An agent config file Kotilo refuses to modify because it could not understand it.</summary>
public sealed class HookConfigException : Exception
{
    public HookConfigException()
    {
    }

    public HookConfigException(string message)
        : base(message)
    {
    }

    public HookConfigException(string message, Exception inner)
        : base(message, inner)
    {
    }
}

/// <summary>The command Kotilo writes into an agent's hook config for one event.</summary>
public static class HookCommand
{
    /// <summary>Marker that identifies Kotilo's entries in any agent's config (<see cref="Brand.HookMarker"/>).</summary>
    public static string ExeMarker => Brand.Current.HookMarker;

    public static string For(string hookExePath, string agent, string eventName) =>
        $"\"{hookExePath}\" --agent {agent} --event {eventName}";

    /// <summary>Unquoted form for agents whose Windows shell wrapper breaks on quotes (Codex, D-013). <paramref name="hookExePath"/> must not contain whitespace.</summary>
    public static string Unquoted(string hookExePath, string agent, string eventName) =>
        $"{hookExePath} --agent {agent} --event {eventName}";

    /// <summary>
    /// True when the command (or plugin text) carries the current marker or a legacy one from before a rename: those entries
    /// are ours, so uninstall removes them and install/repair rewrites them to the current exe. Nothing else is touched.
    /// </summary>
    public static bool IsOwn(string? command) => IsOwn(command, Brand.Current.OwnedHookMarkers);

    public static bool IsOwn(string? command, IReadOnlyList<string> markers) =>
        command is not null && markers.Any(m => command.Contains(m, StringComparison.OrdinalIgnoreCase));

    /// <summary>The exe path of a command in any form Kotilo writes (quoted, unquoted, PowerShell <c>&amp; '…'</c>, POSIX <c>'…'</c>).</summary>
    public static string ExePath(string command)
    {
        var c = command.Trim();
        if (c.StartsWith("& ", StringComparison.Ordinal))
        {
            // PowerShell call operator: & 'C:\…\kotilo-hook.exe' --agent …
            c = c[2..].TrimStart();
        }

        if (c.StartsWith('\''))
        {
            // PowerShell single-quoted string: '' is an escaped quote (C:\Users\O''Neil\…).
            // POSIX: '\'' ends the string, adds an escaped quote and starts a new one (/Users/O'\''Neil/…).
            var path = new System.Text.StringBuilder();
            for (var i = 1; i < c.Length; i++)
            {
                if (c[i] != '\'')
                {
                    path.Append(c[i]);
                }
                else if (i + 1 < c.Length && c[i + 1] == '\'')
                {
                    path.Append('\'');
                    i++;
                }
                else if (c.AsSpan(i).StartsWith(@"'\''", StringComparison.Ordinal))
                {
                    path.Append('\'');
                    i += 3;
                }
                else
                {
                    break;
                }
            }

            return path.ToString();
        }

        if (c.StartsWith('"'))
        {
            var end = c.IndexOf('"', 1);
            return end > 0 ? c[1..end] : c.Trim('"');
        }

        var space = c.IndexOf(' ', StringComparison.Ordinal);
        return space > 0 ? c[..space] : c;
    }
}
