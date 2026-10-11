using System.Text.Json;
using Hub.Core.Adapters;
using Hub.Infrastructure.Adapters;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Serilog;

namespace Hub.Service.Api;

/// <summary>Hook installation state of one adapter (<c>state</c>: missing | installed | outdated | invalidConfig | unsupported).</summary>
/// <param name="Hint">Why installed hooks may stay silent (<c>folderTrust</c>), or null.</param>
public sealed record HookStatusDto(string State, string? ConfigPath, bool NeedsApproval, string? Hint = null)
{
    public static HookStatusDto From(HookStatus status) => new(StateName(status.State), status.ConfigPath, status.NeedsApproval, status.Hint);

    public static string StateName(HookInstallState state) => JsonNamingPolicy.CamelCase.ConvertName(state.ToString());
}

/// <summary>
/// One adapter for the Settings → Agents screen. <c>definition</c> is the adapter.json as written (null when the file was
/// not found or could not be parsed); <c>hooks</c> is null for agents without hooks (protocol adapters); <c>error</c> says
/// why a definition is not used.
/// </summary>
public sealed record AdapterDto(string Id, string DisplayName, AdapterSource Source, JsonElement? Definition, HookStatusDto? Hooks, string? Error)
{
    public static AdapterDto From(AdapterEntry e) => new(
        e.Id, e.DisplayName, e.Source, e.Definition?.Json, e.Installer is { } i ? HookStatusDto.From(i.GetStatus()) : null, e.Error);
}

public sealed record HookActionResultDto(string State, string? BackupPath, bool NeedsApproval);

/// <summary>Adapters and their hook installers (docs/hub-api.md §Ingest and adapters).</summary>
internal static class AdapterEndpoints
{
    public static void Map(IEndpointRouteBuilder app, AdapterCatalog catalog)
    {
        app.MapGet("/v1/adapters", () => ApiJson.Ok(catalog.Entries.Select(AdapterDto.From).ToList()));

        app.MapPost("/v1/adapters/reload", () =>
        {
            var entries = catalog.Reload();
            Log.Information(
                "Adapters reloaded: {Count} ({Errors} with errors)", entries.Count, entries.Count(e => e.Error is not null));
            return ApiJson.Ok(entries.Select(AdapterDto.From).ToList());
        });

        app.MapPost("/v1/adapters/{id}/hooks/install", (string id) => HookAction(catalog, id, i => i.Install()));
        app.MapPost("/v1/adapters/{id}/hooks/uninstall", (string id) => HookAction(catalog, id, i => i.Uninstall()));
    }

    /// <summary>200 with the new state; 404 unknown id; 409 for an agent without hooks; 422 unreadable config; 500 I/O.</summary>
    private static IResult HookAction(AdapterCatalog catalog, string id, Func<IHookInstaller, string?> action)
    {
        if (catalog.Find(id) is not { } entry)
        {
            return ApiJson.Error(StatusCodes.Status404NotFound, "unknownAdapter", $"No adapter '{id}'.");
        }

        if (entry.Installer is not { } installer)
        {
            return ApiJson.Error(StatusCodes.Status409Conflict, "noHooks", $"'{id}' reports through the Agent Integration Protocol and has no hooks to install.");
        }

        try
        {
            var backup = action(installer);
            var status = installer.GetStatus();
            Log.Information("Hooks for {Adapter}: {State}", id, status.State);
            return ApiJson.Ok(new HookActionResultDto(HookStatusDto.StateName(status.State), backup, status.NeedsApproval));
        }
        catch (HookConfigException ex)
        {
            Log.Warning("Hooks for {Adapter} not changed: {Message}", id, ex.Message);
            return ApiJson.Error(StatusCodes.Status422UnprocessableEntity, "invalidConfig", ex.Message);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warning("Hooks for {Adapter} failed: {Message}", id, ex.Message);
            return ApiJson.Error(StatusCodes.Status500InternalServerError, "io", ex.Message);
        }
    }
}
