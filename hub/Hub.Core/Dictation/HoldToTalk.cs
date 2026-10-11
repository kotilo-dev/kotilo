namespace Hub.Core.Dictation;

/// <summary>How a running recording ends (spec §22.1).</summary>
public enum TalkMode
{
    /// <summary>Just pressed; not yet known whether the key is held or tapped.</summary>
    Undecided,

    /// <summary>Key held past <see cref="HoldToTalk.HoldThreshold"/>: releasing it stops.</summary>
    Hold,

    /// <summary>Key tapped: recording runs until the shortcut is pressed again.</summary>
    Toggle,
}

/// <summary>
/// One shortcut for both styles (spec §22.1): hold to talk, or tap to start and tap again to stop. RegisterHotKey only
/// reports the press, so the caller polls whether the key is still down and feeds it here.
/// </summary>
public sealed class HoldToTalk
{
    public static readonly TimeSpan HoldThreshold = TimeSpan.FromMilliseconds(350);

    private DateTimeOffset _pressedAt;

    public TalkMode Mode { get; private set; } = TalkMode.Undecided;

    public void Begin(DateTimeOffset now)
    {
        _pressedAt = now;
        Mode = TalkMode.Undecided;
    }

    /// <returns>True when the recording should stop now (the held key was released).</returns>
    public bool Observe(bool keyDown, DateTimeOffset now)
    {
        switch (Mode)
        {
            case TalkMode.Undecided when keyDown:
                if (now - _pressedAt >= HoldThreshold)
                {
                    Mode = TalkMode.Hold;
                }

                return false;
            case TalkMode.Undecided:
                // Released: a quick tap toggles; a release right at the threshold still counts as a hold.
                if (now - _pressedAt < HoldThreshold)
                {
                    Mode = TalkMode.Toggle;
                    return false;
                }

                Mode = TalkMode.Hold;
                return true;
            case TalkMode.Hold:
                return !keyDown;
            default:
                return false;
        }
    }
}
