using Hub.Core.Ai;
using Hub.Core.Buddy;
using Hub.Infrastructure;
using Hub.Infrastructure.Ai;
using Hub.Infrastructure.Buddy;
using Hub.Infrastructure.Data;
using Serilog;

namespace Hub.Service.Hosting;

/// <param name="Text">The answer as far as it got (kept when stopped).</param>
/// <param name="Error">Message for the user when <see cref="ErrorKind"/> is not None; never logged with content.</param>
public sealed record BuddyAnswer(string Text, string? SessionId, string? Model, AiErrorKind ErrorKind, string? Error);

/// <summary>
/// Bip's backend (spec §17.1). The chat (<see cref="AskAsync"/>) is one <c>claude -p</c> process per message in the buddy
/// folder, resumable, with every tool off (D-070). One-shot generation (<see cref="GenerateAsync"/>: daily summary,
/// dictation cleanup) goes through the provider the user picked for that feature (M3, ARCHITECTURE §3a). Authentication
/// is the user's own agent login or vault key: no agent credential file is read here.
/// </summary>
public sealed class BuddyService
{
    /// <summary>Kept short: the CLI already adds its own system prompt.</summary>
    private static readonly string SystemPrompt =
        $"You are Bip, the small helper inside {Hub.Core.Brand.Current.Name}. You have no tools in this chat: you cannot read files, " +
        "run commands or browse. Never write tool calls or <function_calls> markup. If asked to do something that needs a " +
        "tool, say briefly that you cannot here and explain how the user can do it. Answer in the user's language, short and to the point.";

    /// <summary>Default limit of a one-shot generation.</summary>
    public static readonly TimeSpan GenerateTimeout = TimeSpan.FromMinutes(2);

    private readonly AppPaths _paths;
    private readonly AiProviderResolver _ai;
    private int _busy;

    public BuddyService(AppPaths paths, Database db, AiProviderResolver ai)
    {
        _paths = paths;
        _ai = ai;
        Chats = new BuddyChatRepository(db);
        Transcripts = new BuddyTranscriptReader(paths.ClaudeProjectsDir);
        Filter = new BuddySessionFilter(paths.BuddyDir);
    }

    /// <summary>Empty working folder of the providers' CLI runs: below the buddy folder, so they stay out of sessions and land in "Buddy" usage.</summary>
    public static string ScratchDirOf(AppPaths paths) => Path.Combine(paths.BuddyDir, "ai-scratch");

    public BuddyChatRepository Chats { get; }

    public BuddyTranscriptReader Transcripts { get; }

    public BuddySessionFilter Filter { get; }

    public string BuddyDir => _paths.BuddyDir;

    public bool IsBusy => Volatile.Read(ref _busy) == 1;

    /// <param name="onText">Called with the full answer so far, on a background thread.</param>
    public async Task<BuddyAnswer> AskAsync(string message, string? resumeSessionId, string? model, Action<string> onText, CancellationToken ct)
    {
        if (Interlocked.Exchange(ref _busy, 1) == 1)
        {
            return new BuddyAnswer("", null, null, AiErrorKind.Failed, "busy");
        }

        try
        {
            if (ClaudeCliLocator.Find() is not { } claude)
            {
                return new BuddyAnswer("", null, null, AiErrorKind.NotInstalled, null);
            }

            Directory.CreateDirectory(BuddyDir);
            var run = await ClaudeCliRunner.RunAsync(claude, message, model, resumeSessionId, SystemPrompt, BuddyDir, onText, ct);
            Log.Information(
                "Buddy answer: first text {First} ms, total {Total} ms, exit {Exit}, tokens {In}/{Out}, {Kind}",
                run.FirstTextMs, run.ElapsedMs, run.ExitCode, run.InputTokens, run.OutputTokens, run.ErrorKind);
            return new BuddyAnswer(run.Text, run.SessionId, run.Model, run.ErrorKind, run.Detail);
        }
        finally
        {
            Volatile.Write(ref _busy, 0);
        }
    }

    /// <summary>
    /// One-shot generation with its own system prompt through the feature's provider (spec §18.7, §22.3): a new
    /// session each time, independent of the chat's one-request lock.
    /// </summary>
    public Task<AiResult> GenerateAsync(AiFeature feature, string message, string systemPrompt, TimeSpan timeout, CancellationToken ct) =>
        _ai.CompleteAsync(feature, systemPrompt, message, timeout, ct);
}
