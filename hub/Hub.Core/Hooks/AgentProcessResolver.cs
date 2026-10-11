namespace Hub.Core.Hooks;

/// <summary>
/// Picks the long-lived agent process (claude.exe, codex.exe, node.exe, …) from the hook's ancestor chain by
/// skipping shells and the hook itself (decision D-021). Agent-neutral: hooks are always run through a shell.
/// </summary>
public static class AgentProcessResolver
{
    private static readonly HashSet<string> Shells = new(StringComparer.OrdinalIgnoreCase)
    {
        "bash", "sh", "dash", "zsh", "cmd", "pwsh", "powershell", "conhost", "env", "wsl", Brand.Current.HookMarker,
    };

    public static int? Resolve(HookEvent e)
    {
        foreach (var p in e.ProcessChain)
        {
            if (p.Pid > 0 && p.Pid != e.HookPid && !Shells.Contains(StripExe(p.Name)))
            {
                return p.Pid;
            }
        }

        return e.ParentPid;
    }

    private static string StripExe(string name) =>
        name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name[..^4] : name;
}
