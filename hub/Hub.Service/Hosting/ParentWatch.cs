using System.Diagnostics;
using System.Globalization;

namespace Hub.Service.Hosting;

/// <summary>
/// <c>--parent-pid &lt;pid&gt;</c>: the desktop app's supervisor passes its own pid so the hub shuts down gracefully
/// (draining queued events) once the app is gone, instead of being killed.
/// </summary>
public static class ParentWatch
{
    public static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(1);

    /// <summary>The pid after <c>--parent-pid</c>, or null when absent or not a positive number.</summary>
    public static int? ParsePid(IReadOnlyList<string> args)
    {
        for (var i = 0; i < args.Count - 1; i++)
        {
            if (args[i] == "--parent-pid" && int.TryParse(args[i + 1], NumberStyles.None, CultureInfo.InvariantCulture, out var pid) && pid > 0)
            {
                return pid;
            }
        }

        return null;
    }

    /// <summary>Completes once <paramref name="isAlive"/> reports the parent gone, or when <paramref name="ct"/> is cancelled.</summary>
    public static async Task WaitForExitAsync(Func<bool> isAlive, TimeProvider time, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(PollInterval, time);
        while (isAlive() && await timer.WaitForNextTickAsync(ct))
        {
        }
    }

    /// <summary>
    /// Liveness of a real process. The start time captured now guards against the pid being reused by an unrelated
    /// process after the parent exits.
    /// </summary>
    public static Func<bool> ProcessProbe(int pid)
    {
        DateTime? started = StartTime(pid);
        return () => started is { } s && StartTime(pid) == s;
    }

    private static DateTime? StartTime(int pid)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            return p.HasExited ? null : p.StartTime;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return null;
        }
    }
}
