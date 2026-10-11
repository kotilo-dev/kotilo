using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using Hub.Core.Sessions;

namespace Hub.Infrastructure.Sessions;

/// <summary>
/// Real probes for the stale / process-exit timer. Guards against PID reuse by remembering each PID's
/// start time the first time it is seen (decision D-021).
/// </summary>
public sealed class SessionEnvironment : ISessionEnvironment
{
    private readonly ConcurrentDictionary<int, DateTime> _startTimes = new();

    public DateTimeOffset? GetTranscriptLastWrite(string? transcriptPath)
    {
        if (string.IsNullOrEmpty(transcriptPath))
        {
            return null;
        }

        try
        {
            var info = new FileInfo(transcriptPath);
            return info.Exists ? new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    public bool IsProcessAlive(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            if (process.HasExited)
            {
                return false;
            }

            var started = process.StartTime;
            var known = _startTimes.GetOrAdd(pid, started);
            return known == started;
        }
        catch (ArgumentException)
        {
            // No process with this id.
            _startTimes.TryRemove(pid, out _);
            return false;
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception or NotSupportedException)
        {
            // Access denied or similar: we cannot tell, so assume alive.
            return true;
        }
    }
}
