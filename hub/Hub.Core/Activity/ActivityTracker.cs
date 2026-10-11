using Hub.Core.Hooks;
using Hub.Core.Sessions;

namespace Hub.Core.Activity;

/// <summary>Kind of a timeline entry; <see cref="Turn"/> marks a user prompt.</summary>
public enum ActivityKind
{
    Read,
    Edit,
    Write,
    Bash,
    Search,
    Task,
    Other,
    Turn,
}

public enum ActivityStatus
{
    Running,
    Ok,
    Failed,
    Denied,
}

/// <summary>
/// One timeline entry. Tool entries carry <see cref="Tool"/>, <see cref="Target"/> (path relative to the project when
/// inside it, else the absolute path, else the command or label, clipped), <see cref="Status"/> and, once finished,
/// <see cref="DurationMs"/>. A turn marker has only <see cref="Kind"/> = <see cref="ActivityKind.Turn"/> and <see cref="At"/>.
/// <see cref="Paths"/> lists every file of a multi-file call (<c>apply_patch</c>), else null.
/// </summary>
public sealed record ActivityEntry(
    long Id,
    ActivityKind Kind,
    string? Tool,
    string? Target,
    IReadOnlyList<string>? Paths,
    DateTimeOffset At,
    long? DurationMs,
    ActivityStatus? Status);

public sealed record ActivityPlan(IReadOnlyList<TodoItem> Items);

/// <summary>A session's timeline: entries oldest first, and the latest plan (null when the agent never wrote one).</summary>
public sealed record ActivitySnapshot(IReadOnlyList<ActivityEntry> Entries, ActivityPlan? Plan);

/// <summary>What changed in one session since the last <see cref="ActivityTracker.DrainChanges"/>: new or updated entries and the current plan.</summary>
public sealed record ActivityDelta(string Agent, string SessionId, IReadOnlyList<ActivityEntry> Entries, ActivityPlan? Plan);

/// <summary>
/// Per-session tool timeline (M4, extends D-015), in memory only: never stored, never logged. Fed with accepted hook
/// events on the pipeline consumer; read by the API and the stream from other threads (internally locked).
/// </summary>
/// <remarks>
/// Pairing: a Post event finishes the running entry with the same <c>tool_use_id</c>, else the oldest running entry with
/// the same tool name; without one (Post-only agents: Copilot, Cursor) it adds a finished entry.
/// <see cref="HookEventKind.PostToolUseFailure"/> → failed. A running entry that saw a permission prompt and gets no Post
/// before the turn ends (Stop, Interrupt, next prompt, …) → denied; other entries still running then → failed after an
/// interrupt or error, else ok without a duration.
/// </remarks>
public sealed class ActivityTracker
{
    public const int MaxEntries = 200;
    public const int MaxTargetLength = 200;
    public static readonly TimeSpan EndedRetention = TimeSpan.FromMinutes(10);

    /// <summary>A session without events for this long is dropped even when its end was never seen.</summary>
    public static readonly TimeSpan IdleRetention = TimeSpan.FromHours(12);

    /// <summary>More sessions than this: the least recently active one is dropped.</summary>
    public const int MaxSessions = 256;

    /// <summary>Cursor fires <c>postToolUse</c> and <c>afterShellExecution</c> / <c>afterFileEdit</c> for one call.</summary>
    private static readonly TimeSpan DuplicateWindow = TimeSpan.FromSeconds(3);

    private readonly Lock _gate = new();
    private readonly Dictionary<(string Agent, string SessionId), Ring> _rings = [];
    private long _nextId;

    public int SessionCount
    {
        get
        {
            lock (_gate)
            {
                return _rings.Count;
            }
        }
    }

    /// <summary>Applies one accepted hook event. <paramref name="projectRoot"/> is the session's project root. Returns true when the timeline changed.</summary>
    public bool Observe(HookEvent e, string? projectRoot)
    {
        lock (_gate)
        {
            var key = (e.Agent, e.SessionId);
            if (!_rings.TryGetValue(key, out var ring))
            {
                if (!Creates(e))
                {
                    return false;
                }

                EvictIfFull();
                ring = new Ring();
                _rings[key] = ring;
            }

            ring.LastEventAt = e.ReceivedAt;
            if (!string.IsNullOrEmpty(projectRoot))
            {
                ring.Root = projectRoot;
            }

            var changed = Apply(ring, e);
            if (e.Todos is { } todos)
            {
                ring.Plan = new ActivityPlan(todos);
                ring.PlanChanged = true;
                changed = true;
            }

            return changed;
        }
    }

    public ActivitySnapshot? Get(string agent, string sessionId)
    {
        lock (_gate)
        {
            return _rings.TryGetValue((agent, sessionId), out var ring) ? new ActivitySnapshot([.. ring.Entries], ring.Plan) : null;
        }
    }

    /// <summary>Changes since the previous call, one delta per changed session; resets the change marks.</summary>
    public IReadOnlyList<ActivityDelta> DrainChanges()
    {
        lock (_gate)
        {
            var deltas = new List<ActivityDelta>();
            foreach (var ((agent, sessionId), ring) in _rings)
            {
                if (ring.Changed.Count == 0 && !ring.PlanChanged)
                {
                    continue;
                }

                var entries = ring.Entries.Where(x => ring.Changed.Contains(x.Id)).ToList();
                deltas.Add(new ActivityDelta(agent, sessionId, entries, ring.Plan));
                ring.Changed.Clear();
                ring.PlanChanged = false;
            }

            return deltas;
        }
    }

    /// <summary>
    /// Drops sessions that ended at least <see cref="EndedRetention"/> ago (<paramref name="endedAt"/>: from the session
    /// tracker; a session it no longer knows counts as ended at its last event) or that were idle for <see cref="IdleRetention"/>.
    /// </summary>
    public int Prune(DateTimeOffset now, Func<string, string, DateTimeOffset?> endedAt)
    {
        lock (_gate)
        {
            var stale = _rings
                .Where(kv =>
                    (kv.Value.EndedAt ?? endedAt(kv.Key.Agent, kv.Key.SessionId)) is { } ended && now - ended >= EndedRetention
                    || now - kv.Value.LastEventAt >= IdleRetention)
                .Select(kv => kv.Key)
                .ToList();
            foreach (var key in stale)
            {
                _rings.Remove(key);
            }

            return stale.Count;
        }
    }

    /// <summary>Tool name → entry kind, across agents (Claude, Codex, Gemini, Qwen, Droid, Copilot, Cursor, OpenCode names).</summary>
    public static ActivityKind KindOf(string? tool)
    {
        var t = (tool ?? string.Empty).ToLowerInvariant();
        if (t.StartsWith("mcp__", StringComparison.Ordinal))
        {
            return ActivityKind.Other;
        }

        return t switch
        {
            "read" or "view" or "read_file" or "read_many_files" or "readfile" or "notebookread" or "ls" or "list" or "list_directory"
                or "list_dir" or "listdirectory" => ActivityKind.Read,
            "grep" or "glob" or "search" or "search_file_content" or "grep_search" or "file_search" or "codebase_search" or "find"
                or "websearch" or "web_search" or "google_web_search" or "webfetch" or "web_fetch" or "fetchurl" or "fetch" => ActivityKind.Search,
            "edit" or "multiedit" or "replace" or "str_replace" or "str_replace_editor" or "str_replace_based_edit_tool" or "notebookedit"
                or "apply_patch" or "applypatch" or "patch" or "edit_file" or "search_replace" or "delete" or "delete_file" => ActivityKind.Edit,
            "write" or "create" or "write_file" or "create_file" or "writefile" => ActivityKind.Write,
            "bash" or "shell" or "execute" or "run_shell_command" or "powershell" or "exec_command" or "local_shell" or "shell_command"
                or "run_terminal_cmd" or "terminal" => ActivityKind.Bash,
            "task" or "agent" or "subagent" or "delegate" or "spawn_agent" => ActivityKind.Task,
            _ => ActivityKind.Other,
        };
    }

    /// <summary>
    /// Path relative to <paramref name="root"/> (forward slashes) when inside it; otherwise unchanged. Windows paths
    /// (drive letter) compare case-insensitively and accept both separators.
    /// </summary>
    public static string RelativeTo(string path, string? root)
    {
        if (string.IsNullOrEmpty(root))
        {
            return path;
        }

        var windows = IsDrivePath(path) || IsDrivePath(root);
        var comparison = windows ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var p = windows ? path.Replace('/', '\\') : path;
        var r = (windows ? root.Replace('/', '\\') : root).TrimEnd('\\', '/');
        var sep = windows ? '\\' : '/';
        if (p.Length > r.Length + 1 && p.StartsWith(r, comparison) && p[r.Length] == sep)
        {
            return p[(r.Length + 1)..].Replace('\\', '/');
        }

        return path;
    }

    private static bool IsDrivePath(string s) => s.Length >= 3 && char.IsAsciiLetter(s[0]) && s[1] == ':' && s[2] is '\\' or '/';

    /// <summary>Only tool events and prompts start a timeline; session/state events of a session without one are ignored.</summary>
    private static bool Creates(HookEvent e) => e.Kind is HookEventKind.PreToolUse or HookEventKind.PostToolUse
        or HookEventKind.PostToolUseFailure or HookEventKind.PermissionRequest or HookEventKind.UserPromptSubmit
        || e.Todos is not null;

    private bool Apply(Ring ring, HookEvent e)
    {
        switch (e.Kind)
        {
            case HookEventKind.PreToolUse:
                return Start(ring, e, permission: false);

            case HookEventKind.PermissionRequest:
                return Start(ring, e, permission: true);

            case HookEventKind.Notification when NotificationClassifier.Classify(e.NotificationType, e.Message) == NotificationKind.Permission:
                // Claude's permission_prompt notification names no tool: the newest running entry is the one asking.
                if (ring.Running.LastOrDefault() is { } asking)
                {
                    asking.Permission = true;
                }

                return false;

            case HookEventKind.PostToolUse:
                return Finish(ring, e, ActivityStatus.Ok);

            case HookEventKind.PostToolUseFailure:
                return Finish(ring, e, ActivityStatus.Failed);

            case HookEventKind.UserPromptSubmit:
                EndTurn(ring, interrupted: false);
                Add(ring, new ActivityEntry(NextId(), ActivityKind.Turn, null, null, null, e.ReceivedAt, null, null));
                return true;

            case HookEventKind.Stop or HookEventKind.Done:
                return EndTurn(ring, interrupted: false);

            case HookEventKind.Interrupt or HookEventKind.Error or HookEventKind.StopFailure:
                return EndTurn(ring, interrupted: true);

            case HookEventKind.SessionEnd:
                ring.EndedAt = e.ReceivedAt;
                return EndTurn(ring, interrupted: true);

            default:
                return false;
        }
    }

    private bool Start(Ring ring, HookEvent e, bool permission)
    {
        var tool = e.ToolName ?? "unknown";
        var existing = e.ToolUseId is { } id ? ring.Running.FirstOrDefault(r => r.ToolUseId == id) : null;

        // A PermissionRequest after its PreToolUse (Claude), or a PreToolUse after a PermissionRequest without an id (Codex).
        existing ??= permission
            ? ring.Running.LastOrDefault(r => (e.ToolName is null || r.Tool == tool) && !r.Permission)
            : ring.Running.LastOrDefault(r => r.Tool == tool && r.FromPermission && r.ToolUseId is null);
        if (existing is not null)
        {
            existing.Permission |= permission;
            existing.ToolUseId ??= e.ToolUseId;
            return false;
        }

        var (target, paths) = TargetOf(e, ring.Root);
        var entry = new ActivityEntry(NextId(), KindOf(tool), tool, target, paths, e.ReceivedAt, null, ActivityStatus.Running);
        Add(ring, entry);
        ring.Running.Add(new RunningTool(entry.Id, tool, e.ToolUseId) { Permission = permission, FromPermission = permission });
        return true;
    }

    private bool Finish(Ring ring, HookEvent e, ActivityStatus status)
    {
        var tool = e.ToolName ?? "unknown";
        var running = (e.ToolUseId is { } id ? ring.Running.FirstOrDefault(r => r.ToolUseId == id) : null)
            ?? ring.Running.FirstOrDefault(r => r.Tool == tool && (e.ToolUseId is null || r.ToolUseId is null));
        if (running is not null)
        {
            ring.Running.Remove(running);
            var index = ring.Entries.FindIndex(x => x.Id == running.EntryId);
            if (index < 0)
            {
                return false;
            }

            var started = ring.Entries[index];
            var duration = e.ToolDurationMs ?? Math.Max(0, (long)(e.ReceivedAt - started.At).TotalMilliseconds);
            var (target, paths) = started.Target is null ? TargetOf(e, ring.Root) : (started.Target, started.Paths);
            Replace(ring, index, started with { Status = status, DurationMs = duration, Target = target, Paths = paths });
            return true;
        }

        var (t, p) = TargetOf(e, ring.Root);
        var kind = KindOf(tool);
        var last = ring.Entries.Count > 0 ? ring.Entries[^1] : null;
        if (last is { Status: not ActivityStatus.Running } && last.Kind == kind && last.Target == t && t is not null
            && (e.ReceivedAt - last.At - TimeSpan.FromMilliseconds(last.DurationMs ?? 0)).Duration() < DuplicateWindow)
        {
            return false;
        }

        var startedAt = e.ToolDurationMs is { } ms && ms > 0 ? e.ReceivedAt - TimeSpan.FromMilliseconds(ms) : e.ReceivedAt;
        Add(ring, new ActivityEntry(NextId(), kind, tool, t, p, startedAt, e.ToolDurationMs, status));
        return true;
    }

    private static bool EndTurn(Ring ring, bool interrupted)
    {
        if (ring.Running.Count == 0)
        {
            return false;
        }

        foreach (var running in ring.Running)
        {
            var index = ring.Entries.FindIndex(x => x.Id == running.EntryId);
            if (index < 0)
            {
                continue;
            }

            var status = running.Permission ? ActivityStatus.Denied : interrupted ? ActivityStatus.Failed : ActivityStatus.Ok;
            Replace(ring, index, ring.Entries[index] with { Status = status });
        }

        ring.Running.Clear();
        return true;
    }

    private static (string? Target, IReadOnlyList<string>? Paths) TargetOf(HookEvent e, string? root)
    {
        if (e.ToolPaths is { Count: > 1 } many)
        {
            var rel = many.Select(x => Clip(RelativeTo(x, root))!).ToList();
            return (rel[0], rel);
        }

        var path = e.ToolPath ?? (e.ToolPaths is { Count: > 0 } one ? one[0] : null);
        if (!string.IsNullOrEmpty(path))
        {
            return (Clip(RelativeTo(path, root)), null);
        }

        return (Clip(e.ToolCommand ?? e.ToolDetail), null);
    }

    private static string? Clip(string? s)
    {
        if (s is null)
        {
            return null;
        }

        var line = s.ReplaceLineEndings(" ").Trim();
        return line.Length <= MaxTargetLength ? line : line[..MaxTargetLength];
    }

    private static void Add(Ring ring, ActivityEntry entry)
    {
        ring.Entries.Add(entry);
        ring.Changed.Add(entry.Id);
        if (ring.Entries.Count > MaxEntries)
        {
            var dropped = ring.Entries[0];
            ring.Entries.RemoveAt(0);
            ring.Changed.Remove(dropped.Id);
            ring.Running.RemoveAll(r => r.EntryId == dropped.Id);
        }
    }

    private static void Replace(Ring ring, int index, ActivityEntry entry)
    {
        ring.Entries[index] = entry;
        ring.Changed.Add(entry.Id);
    }

    private long NextId() => ++_nextId;

    private void EvictIfFull()
    {
        if (_rings.Count < MaxSessions)
        {
            return;
        }

        var oldest = _rings.MinBy(kv => kv.Value.LastEventAt).Key;
        _rings.Remove(oldest);
    }

    private sealed class Ring
    {
        public List<ActivityEntry> Entries { get; } = [];

        public List<RunningTool> Running { get; } = [];

        public HashSet<long> Changed { get; } = [];

        public ActivityPlan? Plan { get; set; }

        public bool PlanChanged { get; set; }

        public string? Root { get; set; }

        public DateTimeOffset LastEventAt { get; set; }

        public DateTimeOffset? EndedAt { get; set; }
    }

    private sealed class RunningTool(long entryId, string tool, string? toolUseId)
    {
        public long EntryId { get; } = entryId;

        public string Tool { get; } = tool;

        public string? ToolUseId { get; set; } = toolUseId;

        /// <summary>A permission prompt was shown for this call.</summary>
        public bool Permission { get; set; }

        /// <summary>The entry was created by the permission request itself (no PreToolUse came first).</summary>
        public bool FromPermission { get; init; }
    }
}
