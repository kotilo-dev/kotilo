using Hub.Core.Watch;
using Hub.Service.Hosting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Hub.Service.Api;

/// <summary><c>{ line?, message }</c>: a problem in a project's <c>.kotilo/watch.json</c>.</summary>
public sealed record WatchProjectProblemDto(
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] int? Line,
    string Message);

public sealed record WatchProjectDto(string Root, bool Trusted, int RuleCount, IReadOnlyList<WatchProjectProblemDto> Problems);

/// <summary><c>{ ruleId, message }</c>: a user rule that could not be used.</summary>
public sealed record WatchProblemDto(string? RuleId, string Message);

/// <summary><c>GET /v1/watch</c>: built-ins with their effective <c>enabled</c>/<c>notify</c>, the user's rules, project files and problems.</summary>
public sealed record WatchOverviewDto(
    IReadOnlyList<WatchRule> Builtins, IReadOnlyList<WatchRule> User, IReadOnlyList<WatchProjectDto> Projects, IReadOnlyList<WatchProblemDto> Problems)
{
    public static WatchOverviewDto From(WatchOverview o) => new(
        o.Builtins,
        o.User,
        o.Projects.Select(p => new WatchProjectDto(
            p.Root, p.Trusted, p.RuleCount,
            p.Problems.Select(x => new WatchProjectProblemDto(x.Line, x.RuleId is null ? x.Message : $"{x.RuleId}: {x.Message}")).ToList())).ToList(),
        o.Problems.Select(p => new WatchProblemDto(p.RuleId, p.Message)).ToList());
}

/// <summary><c>POST /v1/watch/test</c> body. Never logged.</summary>
public sealed record WatchTestRequest(string? Tool, string? Command, string? Path, string? Root);

public sealed record WatchTestResponse(IReadOnlyList<WatchHitDto> Matches);

internal static class WatchEndpoints
{
    private const int MaxInput = 4000;

    public static void Map(IEndpointRouteBuilder app, AppHost host)
    {
        app.MapGet("/v1/watch", () => ApiJson.Ok(WatchOverviewDto.From(host.Watch.Engine.Describe())));

        // The command a user types here is as sensitive as one an agent runs: it is evaluated and dropped, never logged.
        app.MapPost("/v1/watch/test", async (HttpRequest request) =>
        {
            var (body, error) = await ApiJson.ReadAsync<WatchTestRequest>(request);
            if (error is not null)
            {
                return error;
            }

            var input = new WatchInput(Clip(body!.Tool), Clip(body.Command), Clip(body.Path), null, Clip(body.Root));
            var hits = host.Watch.Engine.Evaluate(input, sessionKey: null);
            return ApiJson.Ok(new WatchTestResponse(hits.Select(h => new WatchHitDto(h.Id, h.Name)).ToList()));
        });
    }

    private static string? Clip(string? s) => string.IsNullOrEmpty(s) ? null : s.Length <= MaxInput ? s : s[..MaxInput];
}
