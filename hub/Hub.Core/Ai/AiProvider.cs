namespace Hub.Core.Ai;

/// <summary>Why an AI request produced no text. Never carries prompt or response content.</summary>
public enum AiErrorKind
{
    None,

    /// <summary>The agent CLI is not on this machine.</summary>
    NotInstalled,

    /// <summary>The agent CLI runs but has no login (the user logs in in their own terminal).</summary>
    NotLoggedIn,

    /// <summary>The endpoint could not be reached (connection refused, DNS, TLS).</summary>
    Unreachable,

    /// <summary>The endpoint answered 401/403.</summary>
    Unauthorized,

    Timeout,

    Failed,

    Cancelled,

    /// <summary>The feature's provider is missing from the settings, or a model is required and not set.</summary>
    NotConfigured,
}

/// <param name="System">Instructions; agent CLIs without a system prompt flag get it in front of <paramref name="User"/>.</param>
/// <param name="Model">Model id or alias; null uses the provider's default.</param>
public sealed record AiRequest(string System, string User, string? Model, TimeSpan Timeout);

/// <param name="Text">The answer; null or empty on error.</param>
/// <param name="Detail">Short technical reason (exit code, HTTP status, first stderr line); never logged with content.</param>
public sealed record AiResult(string? Text, AiErrorKind ErrorKind, string? Detail)
{
    /// <summary>The model that answered, when the provider reports it.</summary>
    public string? Model { get; init; }

    public bool IsOk => ErrorKind == AiErrorKind.None && !string.IsNullOrWhiteSpace(Text);

    public static AiResult Ok(string text, string? model = null) => new(text, AiErrorKind.None, null) { Model = model };

    public static AiResult Error(AiErrorKind kind, string? detail = null) => new(null, kind, detail);
}

/// <summary>
/// One way to run the hub's own AI work (assistant, daily summary, dictation cleanup; ARCHITECTURE §3a):
/// <c>cli:&lt;adapter id&gt;</c> runs the user's installed agent CLI headless with tools off,
/// <c>openai:&lt;name&gt;</c> calls an OpenAI-compatible endpoint. Implementations never log prompt or answer text (rule 5).
/// </summary>
public interface IAiProvider
{
    /// <summary><c>cli:codex</c>, <c>openai:ollama</c>, …</summary>
    string Id { get; }

    Task<AiResult> CompleteAsync(AiRequest request, CancellationToken ct);
}

/// <summary>Stores small secrets (AI provider keys) in the platform vault. Names are provider names.</summary>
public interface ISecretStore
{
    /// <summary>False where no vault is implemented yet (Write then throws <see cref="PlatformNotSupportedException"/>).</summary>
    bool IsAvailable { get; }

    string? Read(string name);

    void Write(string name, string secret);

    /// <returns>False when there was nothing to delete.</returns>
    bool Delete(string name);
}
