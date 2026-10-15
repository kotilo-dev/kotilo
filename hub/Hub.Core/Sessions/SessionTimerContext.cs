namespace Hub.Core.Sessions;

/// <summary>Environment probes used by the periodic stale / process-exit checks.</summary>
public interface ISessionEnvironment
{
    /// <summary>Last write time of the transcript, or null if unknown / missing.</summary>
    DateTimeOffset? GetTranscriptLastWrite(string? transcriptPath);

    /// <summary>False only when the process is known to be gone. Unknown → true.</summary>
    bool IsProcessAlive(int pid);
}

public sealed record SessionOptions
{
    public TimeSpan StaleAfter { get; init; } = TimeSpan.FromMinutes(10);

    /// <summary>A session without events (and transcript writes) this long and without a known process ends as inactive.</summary>
    public TimeSpan InactiveEndAfter { get; init; } = TimeSpan.FromHours(12);
}
