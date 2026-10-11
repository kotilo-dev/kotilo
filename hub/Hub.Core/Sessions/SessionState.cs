namespace Hub.Core.Sessions;

public enum SessionState
{
    Unknown,
    Idle,
    Working,
    WaitingPermission,
    WaitingInput,
    Ended,
    Stale,

    /// <summary>The turn ended on an API error: usage limit, rate limit, overload, auth (spec §18.5).</summary>
    Error,
}

public static class SessionStateExtensions
{
    /// <summary>States that need the user's action (spec §6.1, §18.5).</summary>
    public static bool NeedsAttention(this SessionState state) =>
        state is SessionState.WaitingPermission or SessionState.WaitingInput or SessionState.Error;

    public static bool IsLive(this SessionState state) =>
        state is not (SessionState.Ended or SessionState.Unknown);
}
