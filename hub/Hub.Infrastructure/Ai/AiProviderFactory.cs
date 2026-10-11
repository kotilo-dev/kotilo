using Hub.Core.Ai;

namespace Hub.Infrastructure.Ai;

/// <summary>One entry of <c>GET /v1/ai/providers</c>.</summary>
public sealed record AiProviderInfo(
    string Id, string Kind, string DisplayName, bool Installed, bool Verified, bool? HasKey, string? BaseUrl, bool IsLoopback);

/// <summary>Builds providers from their ids: the CLI spec table plus the user's OpenAI-compatible endpoints.</summary>
public sealed class AiProviderFactory(string scratchDir, ISecretStore secrets, HttpClient http, Func<CliAgentSpec, string?>? locate = null)
{
    private readonly Func<CliAgentSpec, string?> _locate = locate ?? (spec => CliAgentLocator.Find(spec));

    /// <summary>Empty working folder of every CLI run (inside the buddy folder, so session and usage filters apply).</summary>
    public string ScratchDir => scratchDir;

    public ISecretStore Secrets => secrets;

    public IAiProvider? Create(string providerId, AiSettings settings)
    {
        if (!AiProviderIds.TryParse(providerId, out var kind, out var name))
        {
            return null;
        }

        if (kind == "cli")
        {
            return CliAgentSpecs.Find(name) is { } spec ? new CliAiProvider(spec, () => _locate(spec), scratchDir) : null;
        }

        return settings.Provider(name) is { Kind: AiProviderIds.OpenAiKind } p ? OpenAi(p) : null;
    }

    public OpenAiCompatibleProvider OpenAi(AiProviderConfig config) =>
        new(config.Name, config.BaseUrl, config.Model, () => SafeGet(config.Name), http);

    /// <summary>CLI entries only for agents whose executable is found; every configured endpoint.</summary>
    public IReadOnlyList<AiProviderInfo> List(AiSettings settings)
    {
        var list = CliAgentSpecs.All
            .Where(s => _locate(s) is not null)
            .Select(s => new AiProviderInfo(s.ProviderId, "cli", s.DisplayName, true, s.Verified, null, null, false))
            .ToList();
        list.AddRange(settings.Providers.Select(p => new AiProviderInfo(
            AiProviderIds.OpenAi(p.Name), AiProviderIds.OpenAiKind, p.Name, true, true, HasKey(p.Name), p.BaseUrl, AiProviderIds.IsLoopback(p.BaseUrl))));
        return list;
    }

    public bool HasKey(string name) => SafeGet(name) is { Length: > 0 };

    /// <summary>The agent's executable is found (the CLI is not run).</summary>
    public bool IsInstalled(CliAgentSpec spec) => _locate(spec) is not null;

    /// <summary>A vault read error counts as "no key": the request then goes out without one and reports Unauthorized.</summary>
    private string? SafeGet(string name)
    {
        try
        {
            return secrets.Read(name);
        }
        catch (IOException)
        {
            return null;
        }
    }
}
