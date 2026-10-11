using System.Net;
using System.Text.RegularExpressions;

namespace Hub.Core.Ai;

/// <summary>The hub's own AI jobs; each picks its provider.</summary>
public enum AiFeature
{
    Assistant,
    DailySummary,
    DictationCleanup,
}

/// <summary>A user-defined OpenAI-compatible endpoint. Its key is in the platform vault, never here.</summary>
public sealed record AiProviderConfig
{
    /// <summary>Unique; used in <c>openai:&lt;name&gt;</c>, the key route and the vault target.</summary>
    public string Name { get; init; } = "";

    /// <summary>Only <c>"openai"</c> today.</summary>
    public string Kind { get; init; } = AiProviderIds.OpenAiKind;

    /// <summary>With or without the trailing <c>/v1</c>.</summary>
    public string BaseUrl { get; init; } = "";

    /// <summary>Default model when a feature does not name one.</summary>
    public string? Model { get; init; }
}

public sealed record AiFeatureChoice
{
    /// <summary><c>cli:&lt;adapter id&gt;</c> or <c>openai:&lt;name&gt;</c>.</summary>
    public string Provider { get; init; } = AiProviderIds.DefaultCli;

    /// <summary>Null uses the provider's default model.</summary>
    public string? Model { get; init; }
}

/// <summary><c>settings.ai</c> (M3): providers and the per-feature choice.</summary>
public sealed record AiSettings
{
    /// <summary>The pre-M3 default: Claude Code's small model alias.</summary>
    public const string LegacyDefaultModel = "haiku";

    public IReadOnlyList<AiProviderConfig> Providers { get; init; } = [];

    public AiFeatureChoice Assistant { get; init; } = new() { Model = LegacyDefaultModel };

    public AiFeatureChoice DailySummary { get; init; } = new() { Model = LegacyDefaultModel };

    public AiFeatureChoice DictationCleanup { get; init; } = new() { Model = LegacyDefaultModel };

    public AiFeatureChoice For(AiFeature feature) => feature switch
    {
        AiFeature.Assistant => Assistant,
        AiFeature.DailySummary => DailySummary,
        AiFeature.DictationCleanup => DictationCleanup,
        _ => throw new ArgumentOutOfRangeException(nameof(feature)),
    };

    public AiProviderConfig? Provider(string name) =>
        Providers.FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase));

    /// <summary>Pre-M3 settings: every AI job ran <c>claude -p --model &lt;alias&gt;</c>.</summary>
    public static AiSettings FromLegacy(string? buddyModel, string? dailySummaryModel, string? dictationModel)
    {
        static AiFeatureChoice Cli(string? model) =>
            new() { Provider = AiProviderIds.DefaultCli, Model = string.IsNullOrWhiteSpace(model) ? LegacyDefaultModel : model.Trim() };

        return new AiSettings { Assistant = Cli(buddyModel), DailySummary = Cli(dailySummaryModel), DictationCleanup = Cli(dictationModel) };
    }
}

/// <summary>Provider id syntax and value checks shared by settings validation and the providers.</summary>
public static partial class AiProviderIds
{
    public const string CliPrefix = "cli:";
    public const string OpenAiPrefix = "openai:";
    public const string OpenAiKind = "openai";
    public const string DefaultCli = CliPrefix + "claude-code";

    public static string Cli(string adapterId) => CliPrefix + adapterId;

    public static string OpenAi(string name) => OpenAiPrefix + name;

    /// <summary>Splits <c>cli:codex</c> / <c>openai:ollama</c>; false for anything else.</summary>
    public static bool TryParse(string? id, out string kind, out string name)
    {
        (kind, name) = ("", "");
        if (id is null)
        {
            return false;
        }

        foreach (var (prefix, k) in new[] { (CliPrefix, "cli"), (OpenAiPrefix, OpenAiKind) })
        {
            if (id.StartsWith(prefix, StringComparison.Ordinal) && id.Length > prefix.Length)
            {
                (kind, name) = (k, id[prefix.Length..]);
                return true;
            }
        }

        return false;
    }

    /// <summary>Provider names go into a URL path and a vault target name: letters, digits, <c>. _ -</c>.</summary>
    public static bool IsValidName(string? name) => name is not null && NameRegex().IsMatch(name);

    /// <summary>
    /// Model ids reach agent command lines, so only a conservative character set is accepted
    /// (<c>haiku</c>, <c>gpt-5.1-codex</c>, <c>llama3.1:8b</c>, <c>openai/gpt-4o#high</c>, <c>claude-opus-4[1m]</c>).
    /// </summary>
    public static bool IsValidModel(string? model) => model is not null && ModelRegex().IsMatch(model);

    /// <summary>An absolute http(s) URL without credentials, query or fragment.</summary>
    public static bool IsValidBaseUrl(string? baseUrl) =>
        Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri)
        && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
        && uri.UserInfo.Length == 0 && uri.Query.Length == 0 && uri.Fragment.Length == 0;

    /// <summary><c>localhost</c>, <c>*.localhost</c>, 127.0.0.0/8 or ::1.</summary>
    public static bool IsLoopback(string? baseUrl)
    {
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri))
        {
            return false;
        }

        var host = uri.IdnHost.Trim('[', ']');
        return host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase)
            || (IPAddress.TryParse(host, out var ip) && IPAddress.IsLoopback(ip));
    }

    /// <summary>
    /// "Fully local" badge: every enabled feature uses an <c>openai:</c> provider on a loopback host (agent CLIs talk to
    /// their vendor's cloud). True when no AI feature is enabled.
    /// </summary>
    public static bool IsFullyLocal(AiSettings settings, IEnumerable<AiFeature> enabledFeatures) =>
        enabledFeatures.All(f =>
            TryParse(settings.For(f).Provider, out var kind, out var name)
            && kind == OpenAiKind
            && settings.Provider(name) is { } p
            && IsLoopback(p.BaseUrl));

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$")]
    private static partial Regex NameRegex();

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._:/@#+\-\[\]]{0,127}$")]
    private static partial Regex ModelRegex();
}

/// <summary>
/// Picks the provider for a feature from the settings and runs the request (ARCHITECTURE §3a). The provider objects come
/// from a factory so the infrastructure (processes, HTTP, vault) stays outside Core.
/// </summary>
public sealed class AiProviderResolver(Func<AiSettings> settings, Func<string, AiSettings, IAiProvider?> create, TimeProvider? time = null)
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;

    /// <summary>After every run: metadata only (lengths, duration, error kind), for the log. Never text.</summary>
    public event Action<AiRunInfo>? Completed;

    public AiFeatureChoice Choice(AiFeature feature) => settings().For(feature);

    /// <summary>Null when the id is unknown (an unsupported agent, or an <c>openai:</c> name not in the settings).</summary>
    public IAiProvider? Create(string providerId) => create(providerId, settings());

    public Task<AiResult> CompleteAsync(AiFeature feature, string system, string user, TimeSpan timeout, CancellationToken ct)
    {
        var choice = Choice(feature);
        return CompleteAsync(choice.Provider, choice.Model, system, user, timeout, ct, feature);
    }

    public async Task<AiResult> CompleteAsync(
        string providerId, string? model, string system, string user, TimeSpan timeout, CancellationToken ct, AiFeature? feature = null)
    {
        var started = _time.GetTimestamp();
        var result = Create(providerId) is { } provider
            ? await provider.CompleteAsync(new AiRequest(system, user, model, timeout), ct)
            : AiResult.Error(AiErrorKind.NotConfigured, "unknownProvider");
        result = result with { Model = result.Model ?? model ?? providerId };
        Completed?.Invoke(new AiRunInfo(
            providerId, feature, result.ErrorKind, _time.GetElapsedTime(started), system.Length + user.Length, result.Text?.Length ?? 0)
        {
            Model = result.Model,
        });
        return result;
    }

    /// <summary>A multi-turn chat through the feature's provider; <paramref name="onText"/> as in <see cref="IAiProvider.ChatAsync"/>.</summary>
    public async Task<AiResult> ChatAsync(
        AiFeature feature, string system, IReadOnlyList<AiChatMessage> messages, TimeSpan timeout, Action<string> onText, CancellationToken ct)
    {
        var choice = Choice(feature);
        var started = _time.GetTimestamp();
        var request = new AiChatRequest(system, messages, choice.Model, timeout);
        var result = Create(choice.Provider) is { } provider
            ? await provider.ChatAsync(request, onText, ct)
            : AiResult.Error(AiErrorKind.NotConfigured, "unknownProvider");
        result = result with { Model = result.Model ?? choice.Model };
        Completed?.Invoke(new AiRunInfo(
            choice.Provider, feature, result.ErrorKind, _time.GetElapsedTime(started), request.InputChars, result.Text?.Length ?? 0)
        {
            Model = result.Model,
            Messages = messages.Count,
        });
        return result;
    }
}

/// <summary>What the log may know about one AI run (AGENTS rule 5).</summary>
public sealed record AiRunInfo(string ProviderId, AiFeature? Feature, AiErrorKind ErrorKind, TimeSpan Elapsed, int InputChars, int OutputChars)
{
    public string? Model { get; init; }

    /// <summary>Turns sent (1 for a one-shot request).</summary>
    public int Messages { get; init; } = 1;
}
