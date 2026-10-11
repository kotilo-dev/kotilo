using System.Net;
using System.Security.Cryptography;
using System.Text;
using Hub.Contracts;
using Hub.Core.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Serilog;
using Serilog.Extensions.Logging;

namespace Hub.Service.Hosting;

/// <summary>
/// Loopback-only HTTP API (ARCHITECTURE §5). Binds a random port, publishes it with a fresh token in
/// <c>port.json</c>, and rejects every request without that token. Ingest handlers only enqueue; the pipeline does the work.
/// </summary>
public sealed class IngestServer : IAsyncDisposable
{
    private const long MaxBodyBytes = 1024 * 1024;

    private readonly EventPipeline _pipeline;
    private readonly Func<IReadOnlyList<SessionInfo>> _sessions;
    private readonly Func<UsageSnapshot> _usage;
    private readonly DateTimeOffset _startedAt = DateTimeOffset.UtcNow;
    private readonly byte[] _token;
    private WebApplication? _app;

    public IngestServer(EventPipeline pipeline, Func<IReadOnlyList<SessionInfo>> sessions, Func<UsageSnapshot> usage)
    {
        _pipeline = pipeline;
        _sessions = sessions;
        _usage = usage;
        Token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        _token = Encoding.ASCII.GetBytes(Token);
    }

    public int? Port { get; private set; }

    /// <summary>Random per start; clients read it from <c>port.json</c>. Never logged.</summary>
    public string Token { get; }

    /// <summary>Sessions for <c>/v1/sessions</c>; the argument is <c>includeEnded</c>. Defaults to the live tracker view.</summary>
    public Func<bool, IReadOnlyList<Api.SessionDto>>? SessionsProvider { get; set; }

    /// <summary><c>/v1/stream</c> WebSocket; not mapped when null.</summary>
    public Api.StreamHub? Stream { get; set; }

    /// <summary>Extra route groups (screens API), mapped after the built-in routes. Set before <see cref="StartAsync"/>.</summary>
    public IList<Action<IEndpointRouteBuilder>> Modules { get; } = [];

    /// <summary>Current health issues for <c>/v1/health</c> (spec §18.6); set by the host.</summary>
    public Func<IReadOnlyList<Hub.Core.Insights.HealthIssue>> Health { get; set; } = static () => [];

    /// <summary>Binds a free loopback port and writes port + token to <paramref name="portFile"/>.</summary>
    public async Task<bool> StartAsync(string portFile, CancellationToken ct)
    {
        var app = Build();
        try
        {
            await app.StartAsync(ct);
        }
        catch (IOException ex)
        {
            Log.Error("Could not bind the loopback API: {Message}", ex.Message);
            await app.DisposeAsync();
            return false;
        }

        _app = app;
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        Port = new Uri(address).Port;

        // Written atomically so a client never reads a half-written file. %LOCALAPPDATA% is already private to the user.
        var temp = portFile + ".tmp";
        await File.WriteAllTextAsync(temp, new PortFile(HubApi.PortFileVersion, Port.Value, Token, Environment.ProcessId).ToJson(), ct);
        File.Move(temp, portFile, overwrite: true);
        Log.Information("API listening on 127.0.0.1:{Port}", Port);
        return true;
    }

    public async ValueTask DisposeAsync()
    {
        if (Stream is not null)
        {
            await Stream.DisposeAsync();
        }

        if (_app is not null)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            await _app.StopAsync(timeout.Token);
            await _app.DisposeAsync();
        }
    }

    private WebApplication Build()
    {
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { ContentRootPath = AppContext.BaseDirectory });
        builder.Logging.ClearProviders();
        builder.Logging.AddProvider(new SerilogLoggerProvider(Log.Logger));
        builder.Logging.SetMinimumLevel(LogLevel.Warning);
        builder.WebHost.ConfigureKestrel(k =>
        {
            k.Limits.MaxRequestBodySize = MaxBodyBytes;
            k.AddServerHeader = false;
            k.Listen(IPAddress.Loopback, 0);
        });

        var app = builder.Build();

        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });

        app.Use(async (ctx, next) =>
        {
            // Browsers always send Origin on cross-site requests; local tools never do (CSRF guard).
            if (ctx.Request.Headers.ContainsKey("Origin"))
            {
                ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
                return;
            }

            if (!HasValidToken(ctx.Request))
            {
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }

            await next(ctx);
        });

        // Agent Integration Protocol ingest; /v1/hook is the original Claude Code hook route, kept as an alias.
        app.MapPost("/v1/events", IngestHookAsync);
        app.MapPost("/v1/hook", IngestHookAsync);

        app.MapPost("/v1/statusline", async (HttpRequest request) =>
        {
            using var buffer = new MemoryStream();
            await request.Body.CopyToAsync(buffer);
            return _pipeline.EnqueueStatusLine(buffer.ToArray()) ? Results.StatusCode(202) : Results.StatusCode(503);
        });

        // Active block + today + week. Local calculation, not the official limit.
        app.MapGet("/v1/usage/current", () => Results.Json(Api.UsageCurrentDto.From(_usage()), Api.ApiJson.Options));

        app.MapGet("/v1/health", () => Results.Json(Api.HealthDto.From(Health(), _startedAt), Api.ApiJson.Options));

        app.MapGet("/v1/sessions", (bool? includeEnded) => Results.Json(
            SessionsProvider?.Invoke(includeEnded == true) ?? _sessions().Select(Api.SessionDto.From).ToList(),
            Api.ApiJson.Options));

        if (Stream is { } stream)
        {
            app.Map("/v1/stream", stream.AcceptAsync);
        }

        foreach (var module in Modules)
        {
            module(app);
        }

        return app;
    }

    private async Task<IResult> IngestHookAsync(HttpRequest request)
    {
        using var buffer = new MemoryStream();
        await request.Body.CopyToAsync(buffer);
        return _pipeline.EnqueueHook(buffer.ToArray()) ? Results.StatusCode(202) : Results.StatusCode(503);
    }

    private bool HasValidToken(HttpRequest request)
    {
        var sent = request.Headers[HubApi.TokenHeader].ToString();
        return sent.Length > 0 && CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(sent), _token);
    }
}
