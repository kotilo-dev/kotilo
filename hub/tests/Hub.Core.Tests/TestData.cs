using Hub.Core.Hooks;
using Hub.Core.Sessions;

namespace Hub.Core.Tests;

internal static class TestData
{
    public static readonly DateTimeOffset T0 = new(2026, 9, 30, 18, 0, 0, TimeSpan.Zero);

    public static HookEvent Hook(
        HookEventKind kind,
        DateTimeOffset at,
        string sessionId = "s1",
        string? tool = null,
        string? message = null,
        string? notificationType = null,
        string? reason = null,
        string? cwd = @"C:\src\alpha",
        int? parentPid = 100) =>
        new(sessionId, kind, kind.ToString(), at)
        {
            Cwd = cwd,
            TranscriptPath = @"C:\Users\u\.claude\projects\C--src-alpha\s1.jsonl",
            ToolName = tool,
            Message = message,
            NotificationType = notificationType,
            Reason = reason,
            ParentPid = parentPid,
        };

    public static SessionInfo Session(SessionState state, DateTimeOffset since, string id = "s1", int? pid = 100) =>
        new(id, @"C:\src\alpha", "alpha", @"C:\t\s1.jsonl", state, since, since,
            null, null, null, pid, 0, null, null);
}

internal sealed class FakeEnvironment : ISessionEnvironment
{
    public HashSet<int> DeadPids { get; } = [];

    public DateTimeOffset? TranscriptLastWrite { get; set; }

    public DateTimeOffset? GetTranscriptLastWrite(string? transcriptPath) => TranscriptLastWrite;

    public bool IsProcessAlive(int pid) => !DeadPids.Contains(pid);
}

/// <summary>The built-in code adapters, as the host registers them (the parser has no implicit default registry).</summary>
internal static class TestAdapters
{
    public static readonly Hub.Core.Adapters.AdapterRegistry BuiltIn = new([new Hub.Core.Adapters.ClaudeCodeAdapter(), new Hub.Core.Adapters.CodexAdapter(),
        new Hub.Core.Adapters.GeminiAdapter(), new Hub.Core.Adapters.QwenAdapter(),
        new Hub.Core.Adapters.DroidAdapter(), new Hub.Core.Adapters.CursorAdapter(),
        new Hub.Core.Adapters.CopilotAdapter(), new Hub.Core.Adapters.OpenCodeAdapter()]);
}
