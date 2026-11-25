using Hub.Core.Adapters;
using Hub.Infrastructure.Claude;
using Hub.Service.Hosting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Serilog;

namespace Hub.Service.Api;

/// <summary>
/// Claude Code's statusLine setting (the only way Claude Code reports its 5-hour / weekly plan limits, D-078).
/// <c>state</c>: missing | installed | outdated | invalidConfig. <c>wrappedCommand</c> is the user's own previous command that
/// the helper chains, or null. <c>helperAvailable</c>: the helper exe exists in the tools folder (install needs it).
/// </summary>
public sealed record StatusLineStatusDto(string State, string? ConfigPath, string? WrappedCommand, bool HelperAvailable)
{
    public static string StateName(StatusLineState state) => System.Text.Json.JsonNamingPolicy.CamelCase.ConvertName(state.ToString());
}

public sealed record StatusLineActionResultDto(string State, string? BackupPath, string? WrappedCommand);

/// <summary>docs/hub-api.md §Ingest and adapters: <c>/v1/adapters/claude-code/statusline</c> (status, install, uninstall).</summary>
internal static class StatusLineEndpoints
{
    public static void Map(IEndpointRouteBuilder app, AppHost host)
    {
        app.MapGet("/v1/adapters/claude-code/statusline", () => ApiJson.Ok(Status(host)));
        app.MapPost("/v1/adapters/claude-code/statusline/install", () => Action(host, install: true));
        app.MapPost("/v1/adapters/claude-code/statusline/uninstall", () => Action(host, install: false));
    }

    private static StatusLineStatusDto Status(AppHost host) => new(
        StatusLineStatusDto.StateName(host.HookMerger.GetStatusLineState(host.StatusLineExePath)),
        host.HookMerger.ConfigPath,
        host.Settings.StatusLineWrappedCommand,
        File.Exists(host.StatusLineExePath));

    /// <summary>200 with the new state; 409 when the helper exe is missing (install only); 422 unreadable settings.json; 500 I/O.</summary>
    private static IResult Action(AppHost host, bool install)
    {
        if (install && !File.Exists(host.StatusLineExePath))
        {
            return ApiJson.Error(
                StatusCodes.Status409Conflict, "helperMissing", $"{host.StatusLineExePath} does not exist; reinstall the app.");
        }

        try
        {
            var backup = install ? host.InstallStatusLine() : host.UninstallStatusLine();
            var status = Status(host);
            Log.Information("Claude Code statusLine {Action}: {State}", install ? "install" : "uninstall", status.State);
            return ApiJson.Ok(new StatusLineActionResultDto(status.State, backup, status.WrappedCommand));
        }
        catch (HookConfigException ex)
        {
            Log.Warning("Claude Code statusLine not changed: {Message}", ex.Message);
            return ApiJson.Error(StatusCodes.Status422UnprocessableEntity, "invalidConfig", ex.Message);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warning("Claude Code statusLine failed: {Message}", ex.Message);
            return ApiJson.Error(StatusCodes.Status500InternalServerError, "io", ex.Message);
        }
    }
}
