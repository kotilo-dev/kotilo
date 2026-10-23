using System.Buffers;
using Hub.Core.Adapters;

namespace Hub.Infrastructure.Platform;

/// <summary>A hook command line for one event, and whether the agent's hook runner can actually start it.</summary>
/// <param name="Runs">False when the form needs a path without spaces and none exists (8.3 names disabled).</param>
public sealed record HookCommandForm(string Command, bool Runs);

/// <summary>
/// Platform layer (AGENTS.md rule 7): the agenthub-hook command line in the form an agent's hook runner needs
/// (adapter.json <c>hooks.shell</c>). Every form keeps the <c>agenthub-hook</c> file name, the ownership marker.
/// </summary>
public static class HookCommandLine
{
    /// <summary>Characters a POSIX shell reads literally in an unquoted word (no globbing, expansion or word splitting).</summary>
    private static readonly SearchValues<char> PosixPlain =
        SearchValues.Create("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/._-+,:@%=");

    public static HookCommandForm For(HookShell shell, string hookExePath, string agent, string eventName) =>
        For(shell, hookExePath, agent, eventName, OperatingSystem.IsWindows());

    /// <param name="windows">The form for Windows' hook runners (cmd, PowerShell); otherwise the POSIX shell form.</param>
    internal static HookCommandForm For(HookShell shell, string hookExePath, string agent, string eventName, bool windows)
    {
        if (!windows && shell != HookShell.Cmd)
        {
            // Off Windows the hook runners use a POSIX shell (Gemini `bash -c`, Cursor "bash on Unix"), where the cmd
            // quoting rules and PowerShell's `&` do not apply. A plain path stays unquoted, so existing entries stay
            // current (and Codex keeps its trust). Cmd's "…" form is already valid sh and is left as it was.
            return new(PosixOrPlain(hookExePath, agent, eventName), true);
        }

        switch (shell)
        {
            case HookShell.CmdUnquoted:
                // cmd without verbatim arguments breaks on quotes (Codex, Qwen; D-013).
                return CommandLinePaths.WithoutSpaces(hookExePath) is { } exe
                    ? new(HookCommand.Unquoted(exe, agent, eventName), true)
                    : new(HookCommand.For(hookExePath, agent, eventName), false);

            case HookShell.PowerShell:
                return new(PowerShell(hookExePath, agent, eventName), true);

            case HookShell.Any:
                // cmd, PowerShell and bash all run an unquoted forward-slash path without spaces (Cursor).
                return CommandLinePaths.WithoutSpaces(hookExePath) is { } plain
                    ? new(HookCommand.Unquoted(plain.Replace('\\', '/'), agent, eventName), true)
                    : new(HookCommand.For(hookExePath, agent, eventName), false);

            case HookShell.Cmd:
            default:
                return new(HookCommand.For(hookExePath, agent, eventName), true);
        }
    }

    /// <summary>PowerShell call operator with a single-quoted path (PS 5.1 strips embedded double quotes).</summary>
    public static string PowerShell(string hookExePath, string agent, string eventName) =>
        $"& '{hookExePath.Replace("'", "''", StringComparison.Ordinal)}' --agent {agent} --event {eventName}";

    /// <summary>POSIX shell form (Copilot's <c>bash</c> field; ignored on Windows).</summary>
    public static string Posix(string hookExePath, string agent, string eventName) =>
        $"'{hookExePath.Replace("'", "'\\''", StringComparison.Ordinal)}' --agent {agent} --event {eventName}";

    /// <summary>POSIX shell form, with the path unquoted when the shell reads it literally anyway.</summary>
    private static string PosixOrPlain(string hookExePath, string agent, string eventName) =>
        hookExePath.Length > 0 && !hookExePath.AsSpan().ContainsAnyExcept(PosixPlain)
            ? HookCommand.Unquoted(hookExePath, agent, eventName)
            : Posix(hookExePath, agent, eventName);
}
