using System.Diagnostics;
using System.Globalization;
using System.Text;
using Hub.Core.Insights;

namespace Hub.Infrastructure.Projects;

/// <summary>
/// Runs the git CLI for project status (spec §18.3). No library: if <c>git</c> is not on PATH the feature is off.
/// Commands run below normal priority with a 5 s timeout and <c>GIT_OPTIONAL_LOCKS=0</c>, so a status never takes
/// <c>index.lock</c> away from the user's own git; when the lock is already held the check is skipped for that round.
/// </summary>
public sealed class GitRunner
{
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    private readonly Lazy<string?> _git;

    public GitRunner(string? gitPath = null) => _git = new(() => gitPath ?? FindOnPath());

    public bool IsAvailable => _git.Value is not null;

    public static bool IsRepository(string root) =>
        Directory.Exists(Path.Combine(root, ".git")) || File.Exists(Path.Combine(root, ".git"));

    /// <summary>Null when git is missing, the folder is not a repo, the index is locked, or git failed / timed out.</summary>
    public async Task<GitStatus?> StatusAsync(string root, DateTimeOffset now, CancellationToken ct = default)
    {
        if (!IsAvailable || !IsRepository(root) || IsLocked(root))
        {
            return null;
        }

        var status = await RunAsync(root, ["status", "--porcelain=v2", "--branch"], ct).ConfigureAwait(false);
        if (status is null)
        {
            return null;
        }

        // A repo without commits makes log fail; that only means "no last commit".
        var log = await RunAsync(root, ["log", "-1", "--format=%ct%x09%s"], ct).ConfigureAwait(false);
        return GitStatusParser.Parse(status, log, now);
    }

    /// <summary>Commit subjects since <paramref name="since"/>, newest first, at most <paramref name="max"/>.</summary>
    public async Task<IReadOnlyList<string>> SubjectsSinceAsync(string root, DateTimeOffset since, DateTimeOffset until, int max, CancellationToken ct = default)
    {
        if (!IsAvailable || !IsRepository(root))
        {
            return [];
        }

        var output = await RunAsync(
            root,
            [
                "log", "-n", max.ToString(CultureInfo.InvariantCulture),
                "--since=" + since.ToString("yyyy-MM-ddTHH:mm:sszzz", CultureInfo.InvariantCulture),
                "--until=" + until.ToString("yyyy-MM-ddTHH:mm:sszzz", CultureInfo.InvariantCulture),
                "--format=%s",
            ],
            ct).ConfigureAwait(false);
        return output is null ? [] : output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    private static bool IsLocked(string root) => File.Exists(Path.Combine(root, ".git", "index.lock"));

    private async Task<string?> RunAsync(string root, IReadOnlyList<string> args, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(_git.Value!)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = root,
        };
        foreach (var a in new[] { "-C", root, "-c", "core.quotepath=off", "-c", "i18n.logOutputEncoding=UTF-8", "--no-pager" })
        {
            psi.ArgumentList.Add(a);
        }

        foreach (var a in args)
        {
            psi.ArgumentList.Add(a);
        }

        psi.Environment["GIT_OPTIONAL_LOCKS"] = "0";
        psi.Environment["GIT_TERMINAL_PROMPT"] = "0";

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(Timeout);
        Process? process = null;
        try
        {
            process = Process.Start(psi);
            if (process is null)
            {
                return null;
            }

            try
            {
                process.PriorityClass = ProcessPriorityClass.BelowNormal;
            }
            catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                // Already exited, or not allowed: priority is a courtesy.
            }

            var stdout = process.StandardOutput.ReadToEndAsync(timeout.Token);
            _ = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
            return process.ExitCode == 0 ? await stdout.ConfigureAwait(false) : null;
        }
        catch (OperationCanceledException)
        {
            Kill(process);
            return null;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            return null;
        }
        finally
        {
            process?.Dispose();
        }
    }

    private static void Kill(Process? process)
    {
        try
        {
            process?.Kill(entireProcessTree: true);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
        }
    }

    /// <summary>
    /// The process PATH, then the registered machine and user PATH (a process started from a shell with a trimmed PATH
    /// still finds git), then Git for Windows' default folder.
    /// </summary>
    private static string? FindOnPath()
    {
        var paths = string.Join(
            Path.PathSeparator,
            Environment.GetEnvironmentVariable("PATH"),
            Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Machine),
            Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.User),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Git", "cmd"));
        foreach (var dir in paths.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var candidate = Path.Combine(dir.Trim('"'), "git.exe");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
            catch (ArgumentException)
            {
            }
        }

        return null;
    }
}
