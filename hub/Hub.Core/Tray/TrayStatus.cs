using Hub.Core.Sessions;

namespace Hub.Core.Tray;

/// <summary>Tray icon level, most critical first (spec §11.4).</summary>
public enum TrayLevel
{
    Idle,
    Working,
    WaitingInput,

    /// <summary>A session hit an API error (spec §18.5); ranks after permission requests.</summary>
    Error,
    WaitingPermission,
}

public sealed record TraySummary(TrayLevel Level, int Working, int WaitingPermission, int WaitingInput, int Idle)
{
    public int Errors { get; init; }

    public int Waiting => WaitingPermission + WaitingInput + Errors;

    public static TraySummary From(IEnumerable<SessionInfo> sessions)
    {
        int working = 0, perm = 0, input = 0, idle = 0, errors = 0;
        foreach (var s in sessions)
        {
            switch (s.State)
            {
                case SessionState.Working: working++; break;
                case SessionState.WaitingPermission: perm++; break;
                case SessionState.WaitingInput: input++; break;
                case SessionState.Error: errors++; break;
                case SessionState.Idle or SessionState.Stale: idle++; break;
                default: break;
            }
        }

        var level = perm > 0 ? TrayLevel.WaitingPermission
            : errors > 0 ? TrayLevel.Error
            : input > 0 ? TrayLevel.WaitingInput
            : working > 0 ? TrayLevel.Working
            : TrayLevel.Idle;
        return new TraySummary(level, working, perm, input, idle) { Errors = errors };
    }
}
