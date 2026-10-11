using Hub.Core.Sessions;

namespace Hub.Core.Buddy;

/// <summary>Bip's states (spec §17.5); names match <c>sprites.json</c>.</summary>
public enum MascotState
{
    Sleep,
    Done,
    Work,
    Sweat,
    Input,
    Perm,

    /// <summary>A session ended on an API error (spec §18.5): the input look with a red "!".</summary>
    Error,
}

/// <summary>Everything the mascot reacts to, sampled at one moment.</summary>
/// <param name="Sessions">Visible sessions (buddy sessions already filtered out).</param>
/// <param name="BurnProjectionExceeds">The active block's projection crosses a configured threshold before it ends.</param>
/// <param name="LastCompletedAt">Latest long-turn completion (rule <c>session.completed</c>).</param>
/// <param name="DoNotDisturb">DND / quiet hours: Bip sleeps (design: "Rahatsız etme modunda da bu hâlde kalır").</param>
public sealed record MascotInputs(
    IReadOnlyList<SessionInfo> Sessions,
    bool BurnProjectionExceeds,
    DateTimeOffset? LastCompletedAt,
    bool DoNotDisturb);

/// <summary>Priority: perm &gt; error &gt; input &gt; sweat &gt; work &gt; done (transient) &gt; sleep (spec §17.5, §18.5).</summary>
public static class MascotStateResolver
{
    public static readonly TimeSpan DoneDuration = TimeSpan.FromSeconds(3);

    public static MascotState Resolve(MascotInputs inputs, DateTimeOffset now)
    {
        if (inputs.DoNotDisturb)
        {
            return MascotState.Sleep;
        }

        var live = inputs.Sessions.Where(s => s.State is not (SessionState.Ended or SessionState.Unknown)).ToList();
        if (live.Any(s => s.State == SessionState.WaitingPermission))
        {
            return MascotState.Perm;
        }

        if (live.Any(s => s.State == SessionState.Error))
        {
            return MascotState.Error;
        }

        if (live.Any(s => s.State == SessionState.WaitingInput))
        {
            return MascotState.Input;
        }

        var working = live.Count(s => s.State == SessionState.Working);
        if (inputs.BurnProjectionExceeds && working > 0)
        {
            return MascotState.Sweat;
        }

        if (working > 0)
        {
            return MascotState.Work;
        }

        if (inputs.LastCompletedAt is { } done && now >= done && now - done < DoneDuration)
        {
            return MascotState.Done;
        }

        return MascotState.Sleep;
    }

    /// <summary>Walking speed factor: 1 for one working session, slightly faster for more (capped).</summary>
    public static double SpeedFactor(MascotInputs inputs) =>
        Math.Min(1.6, 1 + (0.15 * Math.Max(0, inputs.Sessions.Count(s => s.State == SessionState.Working) - 1)));

    /// <summary>The session a <see cref="MascotState.Perm"/> click should focus: the one waiting longest.</summary>
    public static SessionInfo? OldestWaitingForPermission(IReadOnlyList<SessionInfo> sessions) =>
        sessions.Where(s => s.State == SessionState.WaitingPermission).OrderBy(s => s.StateSince).FirstOrDefault();
}
