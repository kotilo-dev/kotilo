using System.Text.Json.Serialization;
using Hub.Core.Ai;
using Hub.Infrastructure.Ai;
using Hub.Service.Hosting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Routing;
using Serilog;

namespace Hub.Service.Api;

/// <summary><c>GET /v1/assistant/info</c>.</summary>
/// <param name="Enabled"><c>buddy.enabled</c>.</param>
/// <param name="Provider">The assistant's provider id (<c>ai.assistant.provider</c>).</param>
/// <param name="ProviderLabel">Agent display name for <c>cli:</c>, the endpoint name for <c>openai:</c>.</param>
/// <param name="Model">The configured model (the endpoint's default for <c>openai:</c>); null = the provider's default.</param>
/// <param name="Ephemeral">The provider keeps no copy of the chat on this machine; null = not known for this agent CLI.</param>
/// <param name="UnavailableReason">Why a chat cannot run now (<c>notInstalled</c>, <c>notConfigured</c>); null when <paramref name="Available"/>.</param>
public sealed record AssistantInfoDto(
    bool Enabled, string Provider, string ProviderLabel, string? Model, bool? Ephemeral, bool Available, AiErrorKind? UnavailableReason);

public sealed record AssistantMessageDto(string? Role, string? Text);

public sealed record AssistantChatRequest(IReadOnlyList<AssistantMessageDto?>? Messages);

/// <summary>First line of a chat stream.</summary>
public sealed record AssistantMetaFrame(string Provider, string ProviderLabel, string? Model, bool? Ephemeral)
{
    [JsonPropertyOrder(-1)]
    public string Type => "meta";
}

/// <summary>The full answer so far (not a delta).</summary>
public sealed record AssistantTextFrame(string Text)
{
    [JsonPropertyOrder(-1)]
    public string Type => "text";
}

/// <summary>Last line of a chat stream. <c>error</c>: a short technical reason (exit code, HTTP status), never the conversation.</summary>
public sealed record AssistantDoneFrame(AiErrorKind ErrorKind, string? Error)
{
    [JsonPropertyOrder(-1)]
    public string Type => "done";
}

/// <summary>
/// The assistant chat popup (M7, D-053): one streamed answer per request, no history. The conversation comes from the
/// client with every request and is never stored or logged (rule 5); the log gets provider, model, duration, outcome and
/// counts only (<see cref="AiRunInfo"/>).
/// </summary>
internal static class AssistantEndpoints
{
    /// <summary>At most this many text frames per second; the last text is always sent before <c>done</c>.</summary>
    public static readonly TimeSpan TextInterval = TimeSpan.FromMilliseconds(50);

    private static readonly byte[] NewLine = "\n"u8.ToArray();

    public static void Map(IEndpointRouteBuilder app, AppHost host)
    {
        app.MapGet("/v1/assistant/info", () => ApiJson.Ok(Info(host)));

        app.MapPost("/v1/assistant/chat", async (HttpContext context) =>
        {
            if (!host.Settings.Buddy.Enabled)
            {
                await ApiJson.Error(StatusCodes.Status409Conflict, "disabled", "The assistant is turned off.").ExecuteAsync(context);
                return;
            }

            var (body, error) = await ApiJson.ReadAsync<AssistantChatRequest>(context.Request);
            if (error is not null)
            {
                await error.ExecuteAsync(context);
                return;
            }

            var (messages, fields) = Validate(body!);
            if (fields.Count > 0)
            {
                await ApiJson.BadRequest("The chat request is not valid.", fields).ExecuteAsync(context);
                return;
            }

            using var lease = host.Buddy.TryStartChat();
            if (lease is null)
            {
                await ApiJson.Error(StatusCodes.Status409Conflict, "busy", "Another answer is still running.").ExecuteAsync(context);
                return;
            }

            await StreamAsync(context, host, messages!);
        });
    }

    internal static AssistantInfoDto Info(AppHost host)
    {
        var settings = host.Settings;
        var choice = settings.Ai.Assistant;
        var enabled = settings.Buddy.Enabled;
        if (!AiProviderIds.TryParse(choice.Provider, out var kind, out var name))
        {
            return new(enabled, choice.Provider, choice.Provider, choice.Model, null, false, AiErrorKind.NotConfigured);
        }

        if (kind == "cli")
        {
            if (CliAgentSpecs.Find(name) is not { } spec)
            {
                return new(enabled, choice.Provider, name, choice.Model, null, false, AiErrorKind.NotConfigured);
            }

            var label = host.Adapters.Registry.Find(name)?.DisplayName ?? spec.DisplayName;
            var installed = host.AiProviders.IsInstalled(spec);
            return new(enabled, choice.Provider, label, choice.Model, spec.Ephemeral, installed, installed ? null : AiErrorKind.NotInstalled);
        }

        // OpenAI-compatible: the hub stores nothing; the text goes to the endpoint (the window says so).
        if (settings.Ai.Provider(name) is not { } provider)
        {
            return new(enabled, choice.Provider, name, choice.Model, true, false, AiErrorKind.NotConfigured);
        }

        var model = choice.Model ?? provider.Model;
        return model is null
            ? new(enabled, choice.Provider, provider.Name, null, true, false, AiErrorKind.NotConfigured)
            : new(enabled, choice.Provider, provider.Name, model, true, true, null);
    }

    /// <summary>Roles <c>user</c> / <c>assistant</c>, non-empty text, the last message from the user, within the limits.</summary>
    internal static (IReadOnlyList<AiChatMessage>? Messages, Dictionary<string, string[]> Fields) Validate(AssistantChatRequest body)
    {
        var fields = new Dictionary<string, string[]>(StringComparer.Ordinal);
        if (body.Messages is not { Count: > 0 } list)
        {
            fields["messages"] = ["at least one message"];
            return (null, fields);
        }

        if (list.Count > BuddyService.MaxChatMessages)
        {
            fields["messages"] = [$"at most {BuddyService.MaxChatMessages} messages"];
            return (null, fields);
        }

        var messages = new List<AiChatMessage>(list.Count);
        for (var i = 0; i < list.Count; i++)
        {
            var m = list[i];
            var at = $"messages[{i}]";
            AiChatRole? role = m?.Role switch
            {
                "user" => AiChatRole.User,
                "assistant" => AiChatRole.Assistant,
                _ => null,
            };
            if (role is null)
            {
                fields[at + ".role"] = ["user | assistant"];
            }

            if (string.IsNullOrWhiteSpace(m?.Text))
            {
                fields[at + ".text"] = ["required"];
            }

            if (role is { } r && m?.Text is { } text)
            {
                messages.Add(new AiChatMessage(r, text));
            }
        }

        if (fields.Count > 0)
        {
            return (null, fields);
        }

        if (messages[^1].Role != AiChatRole.User)
        {
            fields["messages"] = ["the last message must be from the user"];
        }
        else if (messages.Sum(m => m.Text.Length) > BuddyService.MaxChatChars)
        {
            fields["messages"] = [$"at most {BuddyService.MaxChatChars} characters in total"];
        }

        return fields.Count > 0 ? (null, fields) : (messages, fields);
    }

    /// <summary>
    /// <c>application/x-ndjson</c>, one flushed line per frame: meta, text (throttled, full text so far), done. A client
    /// abort cancels the run (the CLI process tree is killed, the HTTP stream to the endpoint closed).
    /// </summary>
    private static async Task StreamAsync(HttpContext context, AppHost host, IReadOnlyList<AiChatMessage> messages)
    {
        var aborted = context.RequestAborted;
        var info = Info(host);
        context.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
        context.Response.StatusCode = StatusCodes.Status200OK;
        context.Response.ContentType = "application/x-ndjson; charset=utf-8";
        context.Response.Headers.CacheControl = "no-store";

        var clientGone = false;
        async Task WriteAsync(object frame)
        {
            if (clientGone)
            {
                return;
            }

            try
            {
                await context.Response.Body.WriteAsync(ApiJson.Serialize(frame), aborted);
                await context.Response.Body.WriteAsync(NewLine, aborted);
                await context.Response.Body.FlushAsync(aborted);
            }
            catch (Exception ex) when (ex is OperationCanceledException or IOException or ObjectDisposedException)
            {
                clientGone = true;
            }
        }

        await WriteAsync(new AssistantMetaFrame(info.Provider, info.ProviderLabel, info.Model, info.Ephemeral));

        string? latest = null;
        var chat = host.Buddy.ChatAsync(messages, text => Volatile.Write(ref latest, text), aborted);
        string? sent = null;
        async Task SendLatestAsync()
        {
            var now = Volatile.Read(ref latest);
            if (now is not null && !ReferenceEquals(now, sent))
            {
                sent = now;
                await WriteAsync(new AssistantTextFrame(now));
            }
        }

        while (!chat.IsCompleted)
        {
            await Task.WhenAny(chat, Task.Delay(TextInterval, CancellationToken.None));
            await SendLatestAsync();
        }

        AiResult result;
        try
        {
            result = await chat;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // The type only: a message might quote the conversation.
            Log.Warning("Assistant chat failed: {Type}", ex.GetType().Name);
            result = AiResult.Error(AiErrorKind.Failed, "internal");
        }

        await SendLatestAsync();
        if (result.IsOk && result.Text != sent)
        {
            // The final answer may be trimmed or cleaned compared with the last partial one.
            await WriteAsync(new AssistantTextFrame(result.Text!));
        }

        var kind = result.IsOk ? AiErrorKind.None : result.ErrorKind == AiErrorKind.None ? AiErrorKind.Failed : result.ErrorKind;
        await WriteAsync(new AssistantDoneFrame(kind, kind == AiErrorKind.None ? null : result.Detail));
    }
}
