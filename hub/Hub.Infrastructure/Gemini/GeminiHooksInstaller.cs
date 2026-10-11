using System.Text.Json;
using System.Text.Json.Nodes;
using Hub.Core.Adapters;
using Hub.Infrastructure.Hooks;

namespace Hub.Infrastructure.Gemini;

/// <summary>
/// Kotilo entries in Gemini CLI's user <c>settings.json</c> (JSONC, gemini-cli 0.62 <c>settingsSchema.ts</c>
/// <c>HookDefinitionArray</c>; docs/research/agents-gemini-qwen.md §1.1): Claude-style matcher groups, timeouts in
/// milliseconds. Gemini runs Windows hooks through PowerShell, hence the <c>&amp; '…'</c> command form. The model events
/// (BeforeModel, AfterModel, BeforeToolSelection) are never registered: their payloads are the full conversation.
/// Gemini loads hooks, user ones included, only in trusted folders: <see cref="HookStatus.Hint"/> says so.
/// </summary>
public sealed class GeminiHooksInstaller(string settingsPath, string hookExePath, TimeProvider? time = null) : IHookInstaller
{
    /// <summary>Hook timeout in ms: PowerShell start-up plus the sidecar's 300 ms hub budget fit easily.</summary>
    public const int TimeoutMs = 5000;

    /// <summary>Events Kotilo registers; tool events get the <c>*</c> matcher (a regex over the tool name otherwise).</summary>
    public static readonly IReadOnlyList<HookEventSpec> Events =
    [
        new("SessionStart", TimeoutMs),
        new("SessionEnd", TimeoutMs),
        new("BeforeAgent", TimeoutMs),
        new("BeforeTool", TimeoutMs, "*"),
        new("AfterTool", TimeoutMs, "*"),
        new("AfterAgent", TimeoutMs),
        new("Notification", TimeoutMs),
    ];

    private readonly JsonHooksMerger _hooks = new(
        new JsonHooksOptions(settingsPath, AgentIds.Gemini, Events, HookEntryShape.MatcherGroups, HookShell.PowerShell)
        {
            AllowComments = true,
            DefaultTimeout = TimeoutMs,
            Description = "Gemini CLI settings",
        },
        hookExePath,
        time);

    public string ConfigPath => settingsPath;

    /// <summary>The PowerShell command for one event: <c>&amp; '&lt;exe&gt;' --agent gemini --event &lt;Event&gt;</c>.</summary>
    public string CommandFor(string eventName) => _hooks.CommandFor(eventName);

    public HookStatus GetStatus()
    {
        JsonObject root;
        try
        {
            root = _hooks.File.Load();
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException)
        {
            return new HookStatus(HookInstallState.InvalidConfig, settingsPath);
        }

        var state = _hooks.GetState(root);
        return new HookStatus(state, settingsPath) { Hint = state == HookInstallState.Missing ? null : HintFor(root) };
    }

    public string? Install() => _hooks.Install();

    public string? Uninstall() => _hooks.Uninstall();

    public IReadOnlyList<string> ReferencedHookExes() => _hooks.ReferencedHookExes();

    /// <summary>
    /// <c>hooksConfig.enabled: false</c> switches every hook off; otherwise hooks run only in trusted folders unless
    /// <c>security.folderTrust.enabled</c> is false (the default is true in 0.62).
    /// </summary>
    internal static string? HintFor(JsonObject root)
    {
        if (IsFalse(root, "hooksConfig", "enabled"))
        {
            return HookHints.HooksDisabled;
        }

        return IsFalse(root, "security", "folderTrust", "enabled") ? null : HookHints.FolderTrust;
    }

    /// <summary>The value at the path is JSON <c>false</c>; a missing key or a non-object on the way is not.</summary>
    internal static bool IsFalse(JsonObject root, params string[] path)
    {
        JsonNode? node = root;
        foreach (var key in path)
        {
            node = (node as JsonObject)?[key];
        }

        return node?.GetValueKind() == JsonValueKind.False;
    }
}
