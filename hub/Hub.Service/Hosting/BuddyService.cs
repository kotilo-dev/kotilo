using Hub.Core.Ai;
using Hub.Core.Buddy;
using Hub.Infrastructure;

namespace Hub.Service.Hosting;

/// <summary>
/// The hub's own AI work through the provider the user picked per feature (M3, ARCHITECTURE §3a): the assistant chat
/// (<see cref="ChatAsync"/>, M7) and one-shot generation (<see cref="GenerateAsync"/>: daily summary, dictation cleanup).
/// Chats keep no history: the conversation lives in the client and in memory for one request; nothing is written to the
/// database or logs (rule 5), and agent CLIs run without saving a session where they can. Authentication is the user's
/// own agent login or vault key: no agent credential file is read here.
/// </summary>
public sealed class BuddyService
{
    /// <summary>Default limit of a one-shot generation.</summary>
    public static readonly TimeSpan GenerateTimeout = TimeSpan.FromMinutes(2);

    /// <summary>Limit of one assistant answer.</summary>
    public static readonly TimeSpan ChatTimeout = TimeSpan.FromMinutes(5);

    public const int MaxChatMessages = 40;

    /// <summary>Characters over all messages of one chat request.</summary>
    public const int MaxChatChars = 32_000;

    private readonly AppPaths _paths;
    private readonly AiProviderResolver _ai;
    private int _busy;

    public BuddyService(AppPaths paths, AiProviderResolver ai)
    {
        _paths = paths;
        _ai = ai;
        Filter = new BuddySessionFilter(paths.BuddyDir);
    }

    /// <summary>General chat: no tools and no session or usage context (user decision, M7). Kept short: CLIs add their own.</summary>
    public static string ChatSystemPrompt =>
        $"You are the assistant inside {Hub.Core.Brand.Current.Name}, a desktop app for AI coding agents, answering quick everyday " +
        "questions. You have no tools in this chat: you cannot read files, run commands or browse. Never write tool calls or " +
        "<function_calls> markup; if something needs a tool, say briefly that you cannot do it here and how the user can. " +
        "Answer in the user's language, concise and to the point.";

    /// <summary>Empty working folder of the providers' CLI runs: below the buddy folder, so they stay out of sessions and land in "Buddy" usage.</summary>
    public static string ScratchDirOf(AppPaths paths) => Path.Combine(paths.BuddyDir, "ai-scratch");

    public BuddySessionFilter Filter { get; }

    public string BuddyDir => _paths.BuddyDir;

    public bool IsChatBusy => Volatile.Read(ref _busy) == 1;

    /// <summary>One chat at a time: null while another one runs; dispose the lease when the answer is done.</summary>
    public IDisposable? TryStartChat() => Interlocked.Exchange(ref _busy, 1) == 1 ? null : new ChatLease(this);

    /// <summary>A chat turn through the assistant's provider; <paramref name="onText"/> gets the full answer so far, on a background thread.</summary>
    public Task<AiResult> ChatAsync(IReadOnlyList<AiChatMessage> messages, Action<string> onText, CancellationToken ct) =>
        _ai.ChatAsync(AiFeature.Assistant, ChatSystemPrompt, messages, ChatTimeout, onText, ct);

    /// <summary>
    /// One-shot generation with its own system prompt through the feature's provider (spec §18.7, §22.3): a new
    /// session each time, independent of the chat's one-request lock.
    /// </summary>
    public Task<AiResult> GenerateAsync(AiFeature feature, string message, string systemPrompt, TimeSpan timeout, CancellationToken ct) =>
        _ai.CompleteAsync(feature, systemPrompt, message, timeout, ct);

    private sealed class ChatLease(BuddyService owner) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                Volatile.Write(ref owner._busy, 0);
            }
        }
    }
}
