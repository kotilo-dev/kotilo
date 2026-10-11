using System.Diagnostics;
using Hub.Core.Ai;
using Hub.Infrastructure.Ai;
using Hub.Service.Hosting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Serilog;

namespace Hub.Service.Api;

/// <summary><c>GET /v1/ai/providers</c>.</summary>
/// <param name="FullyLocal">Every enabled AI feature uses an OpenAI-compatible endpoint on a loopback host.</param>
/// <param name="SecretStoreAvailable">False where no platform vault exists yet: keys cannot be saved.</param>
public sealed record AiProvidersDto(IReadOnlyList<AiProviderInfo> Providers, bool FullyLocal, bool SecretStoreAvailable);

public sealed record AiKeyRequest(string? Key);

public sealed record AiTestRequest(string? Provider, string? Model);

/// <summary>Never carries the answer text: only whether a non-empty answer came back.</summary>
public sealed record AiTestResult(bool Ok, AiErrorKind ErrorKind, long LatencyMs);

public sealed record AiModelsDto(IReadOnlyList<string> Models, AiErrorKind ErrorKind);

/// <summary>AI provider routes (M3, ARCHITECTURE §3a). Keys go into the platform vault and never come back out.</summary>
internal static class AiEndpoints
{
    public static readonly TimeSpan TestTimeout = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan ModelsTimeout = TimeSpan.FromSeconds(15);

    private const string TestSystem = "This is a connectivity check. Answer with the single word OK.";
    private const string TestUser = "Reply with OK";

    public static void Map(IEndpointRouteBuilder app, AppHost host)
    {
        app.MapGet("/v1/ai/providers", () =>
        {
            var settings = host.Settings;
            return ApiJson.Ok(new AiProvidersDto(
                host.AiProviders.List(settings.Ai),
                AiProviderIds.IsFullyLocal(settings.Ai, EnabledFeatures(settings)),
                host.AiProviders.Secrets.IsAvailable));
        });

        app.MapPut("/v1/ai/providers/{name}/key", async (string name, HttpRequest request) =>
        {
            if (host.Settings.Ai.Provider(name) is not { } provider)
            {
                return ApiJson.NotFound($"No AI provider named '{name}'.");
            }

            var (body, error) = await ApiJson.ReadAsync<AiKeyRequest>(request);
            if (error is not null)
            {
                return error;
            }

            var key = body!.Key?.Trim();
            if (string.IsNullOrEmpty(key) || key.Length > Infrastructure.Platform.WindowsCredentialStore.MaxSecretLength || key.Any(char.IsControl))
            {
                return ApiJson.BadRequest("The key is not valid.", new Dictionary<string, string[]>
                {
                    ["key"] = [$"1–{Infrastructure.Platform.WindowsCredentialStore.MaxSecretLength} characters, no line breaks"],
                });
            }

            if (!host.AiProviders.Secrets.IsAvailable)
            {
                return ApiJson.Error(StatusCodes.Status501NotImplemented, "notSupported", "No secret store on this platform yet.");
            }

            try
            {
                host.AiProviders.Secrets.Write(provider.Name, key);
            }
            catch (IOException ex)
            {
                Log.Warning("AI provider key could not be stored: {Message}", ex.Message);
                return ApiJson.Error(StatusCodes.Status500InternalServerError, "io", "The key could not be stored.");
            }

            Log.Information("AI provider key stored for {Provider}", provider.Name);
            return Results.NoContent();
        });

        app.MapDelete("/v1/ai/providers/{name}/key", (string name) =>
        {
            try
            {
                host.AiProviders.Secrets.Delete(host.Settings.Ai.Provider(name)?.Name ?? name);
            }
            catch (IOException ex)
            {
                Log.Warning("AI provider key could not be removed: {Message}", ex.Message);
                return ApiJson.Error(StatusCodes.Status500InternalServerError, "io", "The key could not be removed.");
            }

            return Results.NoContent();
        });

        app.MapGet("/v1/ai/providers/{name}/models", async (string name, HttpContext context) =>
        {
            if (host.Settings.Ai.Provider(name) is not { } provider)
            {
                return ApiJson.NotFound($"No AI provider named '{name}'.");
            }

            var list = await host.AiProviders.OpenAi(provider).ListModelsAsync(ModelsTimeout, context.RequestAborted);
            return ApiJson.Ok(new AiModelsDto(list.Models, list.ErrorKind));
        });

        app.MapPost("/v1/ai/test", async (HttpRequest request) =>
        {
            var (body, error) = await ApiJson.ReadAsync<AiTestRequest>(request);
            if (error is not null)
            {
                return error;
            }

            var fields = new Dictionary<string, string[]>(StringComparer.Ordinal);
            var providerId = body!.Provider?.Trim();
            var model = string.IsNullOrWhiteSpace(body.Model) ? null : body.Model.Trim();
            if (!AiProviderIds.TryParse(providerId, out _, out _))
            {
                fields["provider"] = ["cli:<agent id> or openai:<provider name>"];
            }

            if (model is not null && !AiProviderIds.IsValidModel(model))
            {
                fields["model"] = ["letters, digits and . _ : / @ # + - [ ]"];
            }

            if (fields.Count > 0)
            {
                return ApiJson.BadRequest("The test request is not valid.", fields);
            }

            var started = Stopwatch.StartNew();
            var result = await host.Ai.CompleteAsync(providerId!, model, TestSystem, TestUser, TestTimeout, request.HttpContext.RequestAborted);
            return ApiJson.Ok(new AiTestResult(result.IsOk, result.IsOk ? AiErrorKind.None : result.ErrorKind, started.ElapsedMilliseconds));
        });
    }

    /// <summary>The features that would call a provider with the current toggles.</summary>
    public static IEnumerable<AiFeature> EnabledFeatures(AppSettings s)
    {
        if (s.Buddy.Enabled)
        {
            yield return AiFeature.Assistant;
        }

        if (s.Insights.DailySummaryEnabled && !s.Insights.DailySummaryWithoutAi)
        {
            yield return AiFeature.DailySummary;
        }

        if (s.Dictation.Enabled && s.Dictation.AiCleanup)
        {
            yield return AiFeature.DictationCleanup;
        }
    }

    /// <summary>A provider removed from the settings takes its vault entry with it.</summary>
    public static void ForgetRemovedKeys(AppHost host, IEnumerable<string> previousNames)
    {
        foreach (var name in previousNames.Where(n => host.Settings.Ai.Provider(n) is null))
        {
            try
            {
                host.AiProviders.Secrets.Delete(name);
            }
            catch (IOException ex)
            {
                Log.Warning("AI provider key of a removed provider could not be removed: {Message}", ex.Message);
            }
        }
    }
}
