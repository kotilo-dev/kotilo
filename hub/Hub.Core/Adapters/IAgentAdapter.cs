using System.Text.Json;
using Hub.Core.Hooks;

namespace Hub.Core.Adapters;

/// <summary>Built-in adapter ids; they match <c>adapters/&lt;id&gt;/adapter.json</c>.</summary>
public static class AgentIds
{
    public const string ClaudeCode = "claude-code";
    public const string Codex = "codex";
    public const string Gemini = "gemini";
    public const string Qwen = "qwen";
    public const string Droid = "droid";
    public const string Cursor = "cursor";
    public const string Copilot = "copilot";
    public const string OpenCode = "opencode";
}

/// <summary>
/// One supported agent (ARCHITECTURE §3): maps its raw hook payloads to normalized events. File-system parts of an
/// adapter (hook installer, usage and limit readers) live in Hub.Infrastructure next to the files they read.
/// </summary>
public interface IAgentAdapter
{
    string Id { get; }

    string DisplayName { get; }

    /// <summary>Normalized event, or null when the payload lacks a session id.</summary>
    HookEvent? Map(HookEnvelope envelope);
}

/// <summary>
/// Adapters by id; events for an id without an adapter are rejected. Immutable: the host builds a new registry when the
/// adapter definitions are reloaded (built-in code adapters plus a <see cref="GenericAdapter"/> per protocol agent).
/// </summary>
public sealed class AdapterRegistry
{
    private readonly Dictionary<string, IAgentAdapter> _byId;

    /// <param name="adapters">When an id repeats, the first adapter wins.</param>
    public AdapterRegistry(IEnumerable<IAgentAdapter> adapters)
    {
        _byId = new Dictionary<string, IAgentAdapter>(StringComparer.Ordinal);
        foreach (var adapter in adapters)
        {
            _byId.TryAdd(adapter.Id, adapter);
        }
    }

    public static AdapterRegistry Empty { get; } = new([]);

    public IReadOnlyCollection<IAgentAdapter> All => _byId.Values;

    public IAgentAdapter? Find(string id) => _byId.GetValueOrDefault(id);
}

/// <summary>Fields every hook-based adapter copies the same way.</summary>
internal static class AdapterMapping
{
    public const int MaxMessageLength = 500;

    /// <summary>Long enough for any real command line; keeps a runaway payload out of memory.</summary>
    public const int MaxCommandLength = 4000;

    public static HookEvent? Base(string agent, HookEnvelope env, Func<string, HookEventKind> kindOf)
    {
        var p = env.Payload;
        var sessionId = JsonFields.GetString(p, "session_id");
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        var e = new HookEvent(sessionId, kindOf(env.Event), env.Event, env.ReceivedAt)
        {
            Agent = agent,
            PaneId = env.PaneId,
            WorkspaceId = env.WorkspaceId,
            TranscriptPath = JsonFields.GetString(p, "transcript_path"),
            Cwd = JsonFields.GetString(p, "cwd"),
            ToolName = JsonFields.GetString(p, "tool_name"),
            ToolUseId = JsonFields.GetString(p, "tool_use_id"),
            ToolDurationMs = JsonFields.GetLong(p, "duration_ms"),
            Source = JsonFields.GetString(p, "source"),
            Model = JsonFields.GetString(p, "model"),
            // agenthub-hook strips the prompt text and sends only its length (AGENTS.md rule 5).
            PromptLength = JsonFields.GetInt(p, "prompt_length") ?? JsonFields.GetString(p, "prompt")?.Length,
            AgentId = JsonFields.GetString(p, "agent_id"),
            HookPid = env.HookPid,
            ParentPid = env.ParentPid,
            ProcessChain = env.ProcessChain,
        };
        return WithToolInput(e, JsonFields.GetObject(p, "tool_input"));
    }

    /// <summary>
    /// Copies a tool's arguments (already reduced to metadata by agenthub-hook): command, path (<c>file_path</c>,
    /// <c>path</c>, <c>notebook_path</c>, Qwen/Gemini <c>absolute_path</c>, <c>dir_path</c>), <c>apply_patch</c> paths,
    /// a short label (pattern, URL, query, description) and TodoWrite <c>todos</c>. Values already set on the event win.
    /// </summary>
    public static HookEvent WithToolInput(HookEvent e, JsonElement? args)
    {
        if (args is not { } a)
        {
            return e;
        }

        var paths = StringArray(a, "paths");
        return e with
        {
            ToolCommand = e.ToolCommand ?? Clip(JsonFields.GetString(a, "command"), MaxCommandLength),
            ToolPath = e.ToolPath ?? Clip(
                JsonFields.GetString(a, "file_path") ?? JsonFields.GetString(a, "path") ?? JsonFields.GetString(a, "notebook_path")
                    ?? JsonFields.GetString(a, "absolute_path") ?? JsonFields.GetString(a, "filePath") ?? JsonFields.GetString(a, "dir_path")
                    ?? paths?.FirstOrDefault(),
                MaxCommandLength),
            ToolPaths = e.ToolPaths ?? paths,
            ToolDetail = e.ToolDetail ?? Clip(
                JsonFields.GetString(a, "pattern") ?? JsonFields.GetString(a, "url") ?? JsonFields.GetString(a, "query") ?? JsonFields.GetString(a, "description"),
                MaxDetailLength),
            Todos = e.Todos ?? TodoItems(a),
        };
    }

    public const int MaxDetailLength = 200;

    private const int MaxTodos = 100;

    private static List<string>? StringArray(JsonElement obj, string name)
    {
        if (!obj.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var list = v.EnumerateArray()
            .Where(x => x.ValueKind == JsonValueKind.String)
            .Select(x => Clip(x.GetString(), MaxCommandLength)!)
            .Where(x => x.Length > 0)
            .Take(50)
            .ToList();
        return list.Count > 0 ? list : null;
    }

    private static List<TodoItem>? TodoItems(JsonElement obj)
    {
        if (!obj.TryGetProperty("todos", out var v) || v.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        return v.EnumerateArray()
            .Where(x => x.ValueKind == JsonValueKind.Object)
            .Select(x => (Text: JsonFields.GetString(x, "content") ?? JsonFields.GetString(x, "text") ?? JsonFields.GetString(x, "description"), Status: JsonFields.GetString(x, "status")))
            .Where(x => !string.IsNullOrWhiteSpace(x.Text))
            .Take(MaxTodos)
            .Select(x => new TodoItem(Clip(x.Text, MaxDetailLength)!, TodoStatus(x.Status)))
            .ToList();
    }

    private static string TodoStatus(string? status) => status?.ToLowerInvariant() switch
    {
        "in_progress" or "inprogress" or "in-progress" or "active" => "in_progress",
        "completed" or "complete" or "done" => "completed",
        _ => "pending",
    };

    public static string? Truncate(string? s) =>
        s is null || s.Length <= MaxMessageLength ? s : s[..MaxMessageLength];

    public static string? Clip(string? s, int max) => s is null || s.Length <= max ? s : s[..max];
}
