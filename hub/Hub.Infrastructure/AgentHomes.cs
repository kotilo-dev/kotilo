namespace Hub.Infrastructure;

/// <summary>
/// Config / data folders of the agents Kotilo reads or writes (docs/research/agents-*.md), with each agent's own
/// environment override. Tests build it on a temp home with a fake environment, so nothing touches the real home.
/// Claude Code and Codex keep their paths on <see cref="AppPaths"/>.
/// </summary>
/// <param name="userHome"><c>%USERPROFILE%</c> (or a temp folder in tests).</param>
/// <param name="env">Environment lookup; tests pass a dictionary-backed one.</param>
public sealed class AgentHomes(string userHome, Func<string, string?> env)
{
    public string UserHome => userHome;

    /// <summary>Copilot CLI: <c>~/.copilot</c>, or <c>COPILOT_HOME</c> (<c>copilot help environment</c>).</summary>
    public string CopilotHome => Env("COPILOT_HOME") ?? Path.Combine(userHome, ".copilot");

    /// <summary>Copilot's user hooks folder; Kotilo owns <c>agenthub.json</c> in it.</summary>
    public string CopilotHooksDir => Path.Combine(CopilotHome, "hooks");

    /// <summary>Copilot session state (<c>&lt;id&gt;/events.jsonl</c>).</summary>
    public string CopilotSessionStateDir => Path.Combine(CopilotHome, "session-state");

    /// <summary>Gemini CLI: <c>~/.gemini</c>; <c>GEMINI_CLI_HOME</c> replaces the home folder, not the <c>.gemini</c> folder.</summary>
    public string GeminiDir => Path.Combine(Env("GEMINI_CLI_HOME") ?? userHome, ".gemini");

    public string GeminiSettingsPath => Path.Combine(GeminiDir, "settings.json");

    /// <summary>Qwen Code: <c>~/.qwen</c>, or <c>QWEN_HOME</c>.</summary>
    public string QwenHome => Env("QWEN_HOME") ?? Path.Combine(userHome, ".qwen");

    public string QwenSettingsPath => Path.Combine(QwenHome, "settings.json");

    /// <summary>Qwen chat recordings base (<c>projects/&lt;cwd&gt;/chats</c>): <c>QWEN_RUNTIME_DIR</c>, else <see cref="QwenHome"/>.</summary>
    public string QwenRuntimeDir => Env("QWEN_RUNTIME_DIR") ?? QwenHome;

    /// <summary>Factory Droid: <c>~/.factory</c> (no override documented).</summary>
    public string DroidHome => Path.Combine(userHome, ".factory");

    /// <summary>Droid session files (<c>&lt;project-key&gt;/&lt;id&gt;.settings.json</c>, <c>.jsonl</c>).</summary>
    public string DroidSessionsDir => Path.Combine(DroidHome, "sessions");

    /// <summary>Cursor CLI: <c>~/.cursor</c> (no override documented).</summary>
    public string CursorHome => Path.Combine(userHome, ".cursor");

    public string CursorHooksPath => Path.Combine(CursorHome, "hooks.json");

    /// <summary>OpenCode v2 config (plugins): <c>$XDG_CONFIG_HOME/opencode</c>, default <c>~/.config/opencode</c> on every OS.</summary>
    public string OpenCodeConfigDir => Path.Combine(Env("XDG_CONFIG_HOME") ?? Path.Combine(userHome, ".config"), "opencode");

    /// <summary>OpenCode v2 data: <c>$XDG_DATA_HOME/opencode</c>, default <c>~/.local/share/opencode</c>.</summary>
    public string OpenCodeDataDir => Path.Combine(Env("XDG_DATA_HOME") ?? Path.Combine(userHome, ".local", "share"), "opencode");

    /// <summary>OpenCode's SQLite database: <c>OPENCODE_DB</c>, else <c>opencode.db</c> in the data folder.</summary>
    public string OpenCodeDatabasePath => Env("OPENCODE_DB") ?? Path.Combine(OpenCodeDataDir, "opencode.db");

    /// <summary>No environment at all: what tests use by default.</summary>
    public static string? NoEnvironment(string name) => null;

    private string? Env(string name) => env(name) is { Length: > 0 } value && !string.IsNullOrWhiteSpace(value) ? value : null;
}
