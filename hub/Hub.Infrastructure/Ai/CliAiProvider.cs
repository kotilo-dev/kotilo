using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using Hub.Core.Ai;
using Hub.Core.Buddy;
using Hub.Infrastructure.Platform;

namespace Hub.Infrastructure.Ai;

/// <summary>How a CLI run ended. <see cref="Stderr"/> stays in memory (error mapping only) and is never logged.</summary>
public sealed record CliRunOutcome(bool Started, int ExitCode, string Stderr, string? StartError, long ElapsedMs);

/// <summary>Starts an agent CLI for the hub's own AI work: scratch cwd, scrubbed environment, kill on cancel.</summary>
public static class CliProcess
{
    /// <returns>Null when the CLI is a cmd shim that cannot be started without passing free text through cmd.exe.</returns>
    public static ProcessStartInfo? StartInfo(
        string executable, IReadOnlyList<string> arguments, string workingDirectory, IReadOnlyDictionary<string, string>? environment = null)
    {
        if (CliLaunch.Plan(executable, arguments) is not { } plan)
        {
            return null;
        }

        var psi = new ProcessStartInfo(plan.FileName)
        {
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var arg in plan.PrefixArguments.Concat(arguments))
        {
            psi.ArgumentList.Add(arg);
        }

        // Started from inside an agent session (development), the child would think it is nested or bound to a pane.
        foreach (var key in psi.Environment.Keys
                     .Where(k => k == "CLAUDECODE" || k.StartsWith("CLAUDE_CODE_", StringComparison.Ordinal) || k == "AGENTHUB_PANE_ID")
                     .ToList())
        {
            psi.Environment.Remove(key);
        }

        // The hook sidecar drops events from runs that carry this marker.
        psi.Environment[CliAgentSpecs.InternalEnvVar] = "1";
        psi.Environment["NO_COLOR"] = "1";
        foreach (var (key, value) in environment ?? new Dictionary<string, string>())
        {
            psi.Environment[key] = value;
        }

        return psi;
    }

    /// <param name="stdin">Written then closed; null closes stdin at once.</param>
    /// <param name="onLine">Each stdout line; return false to stop the run (the process tree is killed).</param>
    public static async Task<CliRunOutcome> RunAsync(ProcessStartInfo psi, string? stdin, Func<string, bool> onLine, CancellationToken ct)
    {
        var started = Stopwatch.StartNew();
        using var process = new Process { StartInfo = psi };
        try
        {
            process.Start();
        }
        catch (Win32Exception ex)
        {
            return new CliRunOutcome(false, -1, "", ex.Message, started.ElapsedMilliseconds);
        }

        using var cancel = ct.Register(() => Kill(process));
        var stderr = process.StandardError.ReadToEndAsync(CancellationToken.None);
        try
        {
            if (stdin is not null)
            {
                await process.StandardInput.WriteAsync(stdin);
            }

            process.StandardInput.Close();
        }
        catch (IOException)
        {
            // The process exited (or was killed) before reading its input; the exit code tells the rest.
        }

        while (await process.StandardOutput.ReadLineAsync(CancellationToken.None) is { } line)
        {
            if (!onLine(line))
            {
                Kill(process);
                break;
            }
        }

        await process.WaitForExitAsync(CancellationToken.None);
        return new CliRunOutcome(true, process.ExitCode, (await stderr).Trim(), null, started.ElapsedMilliseconds);
    }

    public static bool LooksLikeLogin(string text) =>
        text.Contains("login", StringComparison.OrdinalIgnoreCase)
        || text.Contains("log in", StringComparison.OrdinalIgnoreCase)
        || text.Contains("logged in", StringComparison.OrdinalIgnoreCase)
        || text.Contains("sign in", StringComparison.OrdinalIgnoreCase)
        || text.Contains("authenticat", StringComparison.OrdinalIgnoreCase)
        // Qwen Code before its first sign-in: "No auth type is selected. Please configure an auth type …".
        || text.Contains("auth type", StringComparison.OrdinalIgnoreCase)
        || text.Contains("API key", StringComparison.OrdinalIgnoreCase);

    public static string FirstLine(string text) =>
        text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault() ?? "";

    private static void Kill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
        {
        }
    }
}

public sealed record ClaudeRunResult(
    string Text, string? SessionId, string? Model, AiErrorKind ErrorKind, string? Detail, int ExitCode, long ElapsedMs, long FirstTextMs,
    long InputTokens, long OutputTokens);

/// <summary>
/// <c>claude -p</c> with stream-json output, every tool off and user settings (hooks, MCP, statusline) not loaded
/// (D-070). The prompt goes through stdin. Authentication is the user's own Claude Code login: no credential file is
/// read and no token or API key is handled here.
/// </summary>
public static class ClaudeCliRunner
{
    /// <param name="noSessionPersistence">Chat runs: Claude Code saves no transcript.</param>
    /// <param name="onText">Called with the full answer so far, on a background thread.</param>
    public static async Task<ClaudeRunResult> RunAsync(
        string executable, string message, string? model, string systemPrompt, bool noSessionPersistence, string workingDirectory,
        Action<string> onText, CancellationToken ct)
    {
        var args = CliAgentSpecs.ClaudeArguments(model, systemPrompt, noSessionPersistence).ToList();
        if (CliProcess.StartInfo(executable, args, workingDirectory) is not { } psi)
        {
            return Fail(AiErrorKind.Failed, "unsafeShim");
        }

        var assembler = new BuddyResponseAssembler();
        var started = Stopwatch.StartNew();
        long firstTextMs = -1;
        var toolsReported = false;
        var outcome = await CliProcess.RunAsync(psi, message, line =>
        {
            if (ClaudeCliStreamParser.ParseLine(line) is not { } e)
            {
                return true;
            }

            if (e is BuddyStreamEvent.Init { ToolCount: > 0 })
            {
                // Defense in depth (spec §17.1 criterion 3): never let a run with tools continue.
                toolsReported = true;
                return false;
            }

            if (assembler.Apply(e))
            {
                if (firstTextMs < 0)
                {
                    firstTextMs = started.ElapsedMilliseconds;
                }

                onText(assembler.Text);
            }

            return true;
        }, ct);

        var result = assembler.Result;
        ClaudeRunResult Done(AiErrorKind kind, string? detail) => new(
            assembler.Text, assembler.SessionId, assembler.Model, kind, detail, outcome.ExitCode, outcome.ElapsedMs, firstTextMs,
            result?.InputTokens ?? 0, result?.OutputTokens ?? 0);

        if (!outcome.Started)
        {
            return Done(AiErrorKind.NotInstalled, outcome.StartError);
        }

        if (toolsReported)
        {
            return Done(AiErrorKind.Failed, "tools");
        }

        if (ct.IsCancellationRequested)
        {
            return Done(AiErrorKind.Cancelled, null);
        }

        if (result is { IsError: true } || (outcome.ExitCode != 0 && assembler.Text.Length == 0))
        {
            var detail = result?.Text is { Length: > 0 } r ? r : outcome.Stderr;
            return Done(CliProcess.LooksLikeLogin(detail) ? AiErrorKind.NotLoggedIn : AiErrorKind.Failed, CliProcess.FirstLine(detail));
        }

        return Done(AiErrorKind.None, null);

        static ClaudeRunResult Fail(AiErrorKind kind, string detail) => new("", null, null, kind, detail, -1, 0, -1, 0, 0);
    }
}

/// <summary>
/// <c>cli:&lt;adapter id&gt;</c>: one headless run of the user's installed agent CLI per request, per
/// <see cref="CliAgentSpec"/> (tools off or read-only, never an auto-approve flag), in an empty scratch folder, with
/// <c>AGENTHUB_INTERNAL=1</c>. Prompt and answer are never logged or stored.
/// </summary>
public sealed partial class CliAiProvider(CliAgentSpec spec, Func<string?> locate, string scratchDir) : IAiProvider
{
    /// <summary>Plain-text answers larger than this are cut (a runaway CLI must not fill memory).</summary>
    public const int MaxOutputChars = 512 * 1024;

    public string Id => spec.ProviderId;

    public CliAgentSpec Spec => spec;

    public Task<AiResult> CompleteAsync(AiRequest request, CancellationToken ct) =>
        RunAsync(request.Model, request.Timeout, (exe, token) => spec.Output == CliOutput.ClaudeStreamJson
            ? RunClaudeAsync(exe, request.System, request.User, request.Model, ephemeral: false, static _ => { }, token)
            : RunPlainAsync(exe, request.System, request.User, request.Model, ephemeral: false, token), ct);

    /// <summary>
    /// The conversation goes into one prompt (<see cref="AiChatPrompt"/>); the CLI runs in its no-persistence mode where it
    /// has one. Claude Code streams; the other CLIs answer once at the end.
    /// </summary>
    public Task<AiResult> ChatAsync(AiChatRequest request, Action<string> onText, CancellationToken ct)
    {
        var prompt = AiChatPrompt.Render(request.Messages);
        return RunAsync(request.Model, request.Timeout, async (exe, token) =>
        {
            if (spec.Output == CliOutput.ClaudeStreamJson)
            {
                return await RunClaudeAsync(exe, request.System, prompt, request.Model, ephemeral: true, onText, token);
            }

            var result = await RunPlainAsync(exe, request.System, prompt, request.Model, ephemeral: true, token);
            if (result.IsOk)
            {
                onText(result.Text!);
            }

            return result;
        }, ct);
    }

    private async Task<AiResult> RunAsync(string? model, TimeSpan timeoutAfter, Func<string, CancellationToken, Task<AiResult>> run, CancellationToken ct)
    {
        if (model is not null && !AiProviderIds.IsValidModel(model))
        {
            return AiResult.Error(AiErrorKind.Failed, "invalidModel");
        }

        if (locate() is not { } executable)
        {
            return AiResult.Error(AiErrorKind.NotInstalled);
        }

        Directory.CreateDirectory(scratchDir);
        using var timeout = new CancellationTokenSource(timeoutAfter);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeout.Token);
        var result = await run(executable, linked.Token);

        // The run was killed by the timeout, not by the caller: whatever came back is incomplete.
        return result.ErrorKind != AiErrorKind.None && !ct.IsCancellationRequested && timeout.IsCancellationRequested
            ? AiResult.Error(AiErrorKind.Timeout)
            : result;
    }

    private async Task<AiResult> RunClaudeAsync(
        string executable, string system, string user, string? model, bool ephemeral, Action<string> onText, CancellationToken ct)
    {
        var run = await ClaudeCliRunner.RunAsync(executable, user, model, system, ephemeral, scratchDir, onText, ct);
        return run.ErrorKind == AiErrorKind.None
            ? Answer(run.Text, run.Model)
            : new AiResult(null, run.ErrorKind, run.Detail) { Model = run.Model };
    }

    private async Task<AiResult> RunPlainAsync(string executable, string system, string user, string? model, bool ephemeral, CancellationToken ct)
    {
        var prompt = spec.HasSystemPromptFlag ? user : CliAgentSpecs.CombinePrompt(system, user);
        var viaArgument = spec.PromptInput == CliPromptInput.Argument;
        var invocation = new CliInvocation(viaArgument ? prompt : null, spec.HasSystemPromptFlag ? system : null, model, scratchDir)
        {
            Ephemeral = ephemeral,
        };
        var args = spec.Arguments(invocation).ToList();
        if (CliProcess.StartInfo(executable, args, scratchDir, spec.Environment) is not { } psi)
        {
            return AiResult.Error(AiErrorKind.Failed, "unsafeShim");
        }

        var output = new StringBuilder();
        var outcome = await CliProcess.RunAsync(psi, viaArgument ? null : prompt, line =>
        {
            if (output.Length < MaxOutputChars)
            {
                output.AppendLine(line);
            }

            return true;
        }, ct);

        if (!outcome.Started)
        {
            return AiResult.Error(AiErrorKind.NotInstalled, outcome.StartError);
        }

        if (ct.IsCancellationRequested)
        {
            return AiResult.Error(AiErrorKind.Cancelled);
        }

        var text = Clean(output.ToString());
        if (spec.ExitCodes.TryGetValue(outcome.ExitCode, out var known))
        {
            return AiResult.Error(AiErrorKind.Failed, known);
        }

        if (outcome.ExitCode != 0 || text.Length == 0)
        {
            // Plain-text CLIs print some errors on stdout: check both for a login hint, but only stderr goes into the
            // detail (stdout may hold part of an answer).
            var kind = CliProcess.LooksLikeLogin(outcome.Stderr) || (outcome.ExitCode != 0 && CliProcess.LooksLikeLogin(text))
                ? AiErrorKind.NotLoggedIn
                : AiErrorKind.Failed;
            var stderr = CliProcess.FirstLine(outcome.Stderr);
            return AiResult.Error(kind, outcome.ExitCode == 0 ? "empty" : stderr.Length > 0 ? $"exit {outcome.ExitCode}: {stderr}" : $"exit {outcome.ExitCode}");
        }

        return Answer(text, model);
    }

    private static AiResult Answer(string text, string? model) =>
        text.Trim().Length > 0 ? AiResult.Ok(text.Trim(), model) : new AiResult(null, AiErrorKind.Failed, "empty") { Model = model };

    /// <summary>Removes terminal escape sequences some CLIs print even with NO_COLOR.</summary>
    internal static string Clean(string text) => AnsiRegex().Replace(text, "").Trim();

    [GeneratedRegex(@"\x1B(\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1B]*(\x07|\x1B\\))")]
    private static partial Regex AnsiRegex();
}
