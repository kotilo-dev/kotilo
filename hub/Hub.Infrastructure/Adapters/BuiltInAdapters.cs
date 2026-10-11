using Hub.Core.Adapters;
using Hub.Infrastructure.Claude;
using Hub.Infrastructure.Codex;
using Hub.Infrastructure.Copilot;
using Hub.Infrastructure.Cursor;
using Hub.Infrastructure.Droid;
using Hub.Infrastructure.Gemini;
using Hub.Infrastructure.OpenCode;
using Hub.Infrastructure.Qwen;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Adapters;

/// <summary>
/// The built-in agents' code halves, in display order. A new built-in agent is one more entry here (plus its
/// <c>adapters/&lt;id&gt;/adapter.json</c>): its <see cref="IAgentAdapter"/>, a <see cref="Hooks.JsonHooksMerger"/> (or its own
/// <see cref="IHookInstaller"/>) and its <see cref="IUsageSource"/>s.
/// </summary>
public static class BuiltInAdapters
{
    public static IReadOnlyList<AgentIntegration> Create(AppPaths paths, string hookExePath, UsageSourceContext usage) =>
    [
        new(new ClaudeCodeAdapter(), new ClaudeSettingsMerger(paths.ClaudeSettingsPath, hookExePath))
        {
            UsageSources = [new TranscriptScanner(paths.ClaudeProjectsDir, usage.Offsets, usage.Repository, usage.Pricing, usage.Roots)],
        },
        new(new CodexAdapter(), new CodexHooksMerger(paths.CodexHooksPath, paths.CodexConfigPath, hookExePath))
        {
            UsageSources = [new CodexRolloutScanner(paths.CodexRolloutDirs, usage.Offsets, usage.Repository, usage.Pricing, usage.Roots)],
        },
        new(new GeminiAdapter(), new GeminiHooksInstaller(paths.Agents.GeminiSettingsPath, hookExePath))
        {
            UsageSources = [new GeminiChatScanner(paths.Agents.GeminiDir, usage, Path.Combine(paths.BuddyDir, "ai-scratch"))],
        },
        new(new QwenAdapter(), new QwenHooksInstaller(paths.Agents.QwenSettingsPath, hookExePath))
        {
            UsageSources = [new QwenChatScanner(paths.Agents.QwenRuntimeDir, usage, Path.Combine(paths.BuddyDir, "ai-scratch"))],
        },
        new(new DroidAdapter(), new DroidHooksInstaller(paths.Agents.DroidHome, hookExePath))
        {
            UsageSources = [new DroidSessionScanner(paths.Agents.DroidSessionsDir, usage)],
        },
        new(new CursorAdapter(), new CursorHooksMerger(paths.Agents.CursorHooksPath, hookExePath)),
        new(new CopilotAdapter(), CopilotHooks.Installer(paths.Agents, hookExePath))
        {
            // The hub's own AI runs work in the buddy scratch folder (D-026).
            UsageSources = [new CopilotSessionScanner(paths.Agents.CopilotSessionStateDir, usage, Path.Combine(paths.BuddyDir, "ai-scratch"))],
        },
        new(new OpenCodeAdapter(), new OpenCodePluginInstaller(Path.Combine(paths.Agents.OpenCodeConfigDir, "plugins"), hookExePath))
        {
            UsageSources = [new OpenCodeUsageSource(paths.Agents.OpenCodeDatabasePath, usage)],
        },
    ];
}
