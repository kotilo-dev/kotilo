using Hub.Core.Adapters;

namespace Hub.Core.Ai;

public enum CliPromptInput
{
    /// <summary>Prompt on stdin: nothing user-written on the command line.</summary>
    Stdin,

    /// <summary>Prompt as a command-line argument (the CLI has no stdin mode we could verify).</summary>
    Argument,
}

public enum CliOutput
{
    /// <summary><c>claude -p --output-format stream-json</c>, parsed by <see cref="Buddy.ClaudeCliStreamParser"/>.</summary>
    ClaudeStreamJson,

    /// <summary>The answer as plain text on stdout.</summary>
    PlainText,
}

/// <param name="Prompt">Null when the prompt goes through stdin.</param>
/// <param name="System">Only for CLIs with a system prompt flag; otherwise it is already in the prompt.</param>
public sealed record CliInvocation(string? Prompt, string? System, string? Model, string ScratchDir)
{
    /// <summary>A chat run: add the option that keeps the CLI from saving the session, where <see cref="CliAgentSpec.Ephemeral"/> is true.</summary>
    public bool Ephemeral { get; init; }
}

/// <summary>
/// How one agent CLI runs headless for the hub's own AI work, with tools off or read-only (research:
/// <c>docs/research/agents-*.md</c> "Headless run"). <see cref="Verified"/> = every flag was checked against the
/// installed CLI's <c>--help</c>; the others come from source/docs only and the UI says so.
/// </summary>
/// <param name="Executables">Base names searched on PATH and in <paramref name="KnownDirs"/> (the platform adds <c>.exe</c>/<c>.cmd</c>).</param>
/// <param name="KnownDirs">Install folders with <c>%USERPROFILE%</c>, <c>%APPDATA%</c>, <c>%LOCALAPPDATA%</c> placeholders.</param>
/// <param name="KnownDirOnlyExecutables">Names too generic for PATH (Cursor's <c>agent</c>), looked up only in <paramref name="KnownDirs"/>.</param>
/// <param name="ExitCodes">Exit code → detail for documented failures (Qwen 55 = a tool call was attempted).</param>
public sealed record CliAgentSpec(
    string AdapterId,
    string DisplayName,
    bool Verified,
    IReadOnlyList<string> Executables,
    IReadOnlyList<string> KnownDirs,
    CliPromptInput PromptInput,
    CliOutput Output,
    bool HasSystemPromptFlag,
    Func<CliInvocation, IEnumerable<string>> Arguments)
{
    public IReadOnlyList<string> KnownDirOnlyExecutables { get; init; } = [];

    /// <summary>Extra environment for the run (on top of <c>AGENTHUB_INTERNAL=1</c>).</summary>
    public IReadOnlyDictionary<string, string> Environment { get; init; } = new Dictionary<string, string>();

    public IReadOnlyDictionary<int, string> ExitCodes { get; init; } = new Dictionary<int, string>();

    /// <summary>
    /// Whether a chat run leaves no session or transcript behind: true = an option for that was verified in the installed
    /// CLI's <c>--help</c> and is passed (always, or when <see cref="CliInvocation.Ephemeral"/> is set); false = the
    /// installed CLI has no such option; null = not checked (the CLI was not installed when this was verified).
    /// </summary>
    public bool? Ephemeral { get; init; }

    public string ProviderId => AiProviderIds.Cli(AdapterId);
}

/// <summary>The headless command per agent. Never <c>--yolo</c>, <c>--auto</c>, <c>--allow-all*</c> or a bypass flag.</summary>
public static class CliAgentSpecs
{
    /// <summary>Marks the hub's own runs; the hook sidecar drops events that carry it.</summary>
    public const string InternalEnvVar = "AGENTHUB_INTERNAL";

    /// <summary>Opencode run title, so its usage reader can skip these sessions.</summary>
    public static string RunTitle => Brand.Current.Slug + "-ai";

    private const string Npm = "%APPDATA%\\npm";

    /// <summary>
    /// Claude Code 2.1.296 (stream path unchanged since D-070: no tools, no user settings or MCP); chat runs add
    /// <c>--no-session-persistence</c> (print mode only: nothing saved to disk, cannot be resumed).
    /// </summary>
    public static readonly CliAgentSpec ClaudeCode = new(
        AgentIds.ClaudeCode, "Claude Code", Verified: true, ["claude"], ["%USERPROFILE%\\.local\\bin", Npm],
        CliPromptInput.Stdin, CliOutput.ClaudeStreamJson, HasSystemPromptFlag: true,
        i => ClaudeArguments(i.Model, i.System ?? "", noSessionPersistence: i.Ephemeral))
    {
        Ephemeral = true,
    };

    /// <summary>
    /// codex-cli 0.160.0 <c>codex exec --help</c>: read-only sandbox, never asks, no session file (<c>--ephemeral</c>: "Run
    /// without persisting session files to disk", always on), prompt from stdin (<c>-</c>).
    /// </summary>
    public static readonly CliAgentSpec Codex = new(
        AgentIds.Codex, "Codex", Verified: true, ["codex"], ["%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin", Npm],
        CliPromptInput.Stdin, CliOutput.PlainText, HasSystemPromptFlag: false,
        i => Concat(
            ["exec", "--sandbox", "read-only", "-c", "approval_policy=never", "--skip-git-repo-check", "--ephemeral", "--color", "never", "-C", i.ScratchDir],
            ModelFlag("-m", i.Model),
            ["-"]))
    {
        Ephemeral = true,
    };

    /// <summary>
    /// GitHub Copilot CLI 1.0.91 <c>copilot --help</c>: shell, write and URL access denied, no ask_user, no MCP. No option to
    /// skip saving the session (checked <c>--help</c>, <c>help config</c>, <c>help environment</c>).
    /// </summary>
    public static readonly CliAgentSpec Copilot = new(
        "copilot", "GitHub Copilot CLI", Verified: true, ["copilot"], [Npm],
        CliPromptInput.Argument, CliOutput.PlainText, HasSystemPromptFlag: false,
        i => Concat(
            ["-p", i.Prompt!, "-s", "--no-ask-user", "--no-custom-instructions", "--disable-builtin-mcps", "--no-auto-update", "--no-remote",
                "--no-color", "--log-level", "none", "--deny-tool=shell", "--deny-tool=write", "--deny-tool=url"],
            ModelFlag("--model", i.Model)))
    {
        Ephemeral = false,
    };

    /// <summary>
    /// OpenCode 2.0.22 <c>opencode run --help</c>: a private server, every permission denied through
    /// <c>OPENCODE_CONFIG_CONTENT</c>, no <c>--auto</c>. No option to skip saving the session (<c>run</c> has none).
    /// </summary>
    public static readonly CliAgentSpec OpenCode = new(
        "opencode", "OpenCode", Verified: true, ["opencode"], [Npm],
        CliPromptInput.Argument, CliOutput.PlainText, HasSystemPromptFlag: false,
        i => Concat(["run", "--standalone", "--format", "default", "--title", RunTitle], ModelFlag("-m", i.Model), [i.Prompt!]))
    {
        Environment = new Dictionary<string, string> { ["OPENCODE_CONFIG_CONTENT"] = """{"permission":"deny"}""" },
        Ephemeral = false,
    };

    /// <summary>
    /// Gemini CLI 0.62.0 <c>gemini --help</c>: headless <c>-p</c>, default approval mode denies mutating tools. No option to
    /// skip saving the session.
    /// </summary>
    public static readonly CliAgentSpec Gemini = new(
        "gemini", "Gemini CLI", Verified: true, ["gemini"], [Npm],
        CliPromptInput.Argument, CliOutput.PlainText, HasSystemPromptFlag: false,
        i => Concat(["-p", i.Prompt!, "-o", "text", "--skip-trust", "--approval-mode", "default"], ModelFlag("-m", i.Model)))
    {
        Ephemeral = false,
    };

    /// <summary>
    /// Qwen Code 0.25.0 <c>qwen --help</c>: safe mode (no hooks/MCP), read-only, no chat file (<c>--chat-recording false</c>,
    /// always on), aborts on a tool call (exit 55).
    /// </summary>
    public static readonly CliAgentSpec Qwen = new(
        "qwen", "Qwen Code", Verified: true, ["qwen"], [Npm],
        CliPromptInput.Argument, CliOutput.PlainText, HasSystemPromptFlag: false,
        i => Concat(
            ["-p", i.Prompt!, "-o", "text", "--approval-mode", "plan", "--safe-mode", "--chat-recording", "false", "--max-tool-calls", "0"],
            ModelFlag("-m", i.Model)))
    {
        ExitCodes = new Dictionary<int, string> { [55] = "tools", [53] = "turnLimit" },
        Ephemeral = true,
    };

    /// <summary>From docs (not installed here): <c>droid exec</c> without <c>--auto</c> is read-only.</summary>
    public static readonly CliAgentSpec Droid = new(
        "droid", "Factory Droid", Verified: false, ["droid"], ["%USERPROFILE%\\bin", Npm],
        CliPromptInput.Argument, CliOutput.PlainText, HasSystemPromptFlag: false,
        i => Concat(["exec", "-o", "text", "--cwd", i.ScratchDir], ModelFlag("-m", i.Model), [i.Prompt!]));

    /// <summary>From docs (not installed here): print mode, read-only "ask" mode, no <c>--force</c>.</summary>
    public static readonly CliAgentSpec Cursor = new(
        "cursor", "Cursor CLI", Verified: false, ["cursor-agent"], ["%LOCALAPPDATA%\\cursor-agent"],
        CliPromptInput.Argument, CliOutput.PlainText, HasSystemPromptFlag: false,
        i => Concat(
            ["-p", "--output-format", "text", "--mode", "ask", "--trust", "--workspace", i.ScratchDir],
            ModelFlag("--model", i.Model),
            [i.Prompt!]))
    {
        KnownDirOnlyExecutables = ["agent"],
    };

    public static IReadOnlyList<CliAgentSpec> All { get; } = [ClaudeCode, Codex, Copilot, OpenCode, Gemini, Qwen, Droid, Cursor];

    public static CliAgentSpec? Find(string adapterId) => All.FirstOrDefault(s => s.AdapterId == adapterId);

    /// <summary>
    /// The text a CLI without a system prompt flag receives: instructions, a separator, then the input. It never starts
    /// with <c>-</c>, so a positional prompt cannot be read as a flag.
    /// </summary>
    public static string CombinePrompt(string? system, string user)
    {
        var text = string.IsNullOrWhiteSpace(system) ? user : system.Trim() + "\n\n---\n\n" + user;
        return text.TrimStart().StartsWith('-') ? "Input:\n" + text : text;
    }

    /// <summary>The Claude flags verified against CLI 2.1.286 (D-070), 2.1.291 and 2.1.296.</summary>
    /// <param name="noSessionPersistence">Chat runs: Claude Code writes no transcript (nothing to resume).</param>
    public static IEnumerable<string> ClaudeArguments(string? model, string systemPrompt, bool noSessionPersistence)
    {
        yield return "-p";
        yield return "--output-format";
        yield return "stream-json";
        yield return "--verbose";
        yield return "--include-partial-messages";
        yield return "--tools";
        yield return "";
        yield return "--strict-mcp-config";
        yield return "--setting-sources";
        yield return "project,local";
        if (!string.IsNullOrEmpty(model))
        {
            yield return "--model";
            yield return model;
        }

        yield return "--append-system-prompt";
        yield return systemPrompt;
        if (noSessionPersistence)
        {
            yield return "--no-session-persistence";
        }
    }

    private static IEnumerable<string> ModelFlag(string flag, string? model) =>
        string.IsNullOrEmpty(model) ? [] : [flag, model];

    private static IEnumerable<string> Concat(params IEnumerable<string>[] parts) => parts.SelectMany(p => p);
}
