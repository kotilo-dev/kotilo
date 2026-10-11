using Hub.Core.Adapters;
using Hub.Infrastructure.Hooks;

namespace Hub.Infrastructure.Copilot;

/// <summary>
/// Copilot CLI hook registration: Kotilo's own file <c>$COPILOT_HOME/hooks/agenthub.json</c> (the CLI loads every
/// <c>*.json</c> in its user hooks folder), so no user file is merged and uninstall deletes the file once it holds nothing
/// else. On Windows Copilot runs the <c>powershell</c> field (the <c>bash</c> one elsewhere); the event name goes on the
/// command line because Copilot's camelCase payloads don't carry it.
/// </summary>
public static class CopilotHooks
{
    /// <summary>Fixed under any brand: a renamed file would leave the old entries behind and Copilot would run both.</summary>
    public const string FileName = "agenthub.json";

    /// <summary>Seconds. A timeout is fail-open in Copilot; PowerShell start-up needs more than the default 5.</summary>
    public const int TimeoutSeconds = 10;

    public static JsonHooksMerger Installer(AgentHomes homes, string hookExePath, TimeProvider? time = null) =>
        new(
            new JsonHooksOptions(
                Path.Combine(homes.CopilotHooksDir, FileName),
                AgentIds.Copilot,
                CopilotAdapter.Events.Select(e => new HookEventSpec(e, TimeoutSeconds)).ToList(),
                HookEntryShape.CopilotCommands,
                HookShell.PowerShell)
            {
                FileVersion = 1,
                OwnFile = true,
                Description = "Copilot CLI hooks",
            },
            hookExePath,
            time);
}
