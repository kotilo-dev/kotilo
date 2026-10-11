using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Hub.Core.Ai;

namespace Hub.Infrastructure.Ai;

/// <summary>Outcome of <see cref="OpenAiCompatibleProvider.ListModelsAsync"/>.</summary>
public sealed record AiModelList(IReadOnlyList<string> Models, AiErrorKind ErrorKind, string? Detail);

/// <summary>
/// <c>openai:&lt;name&gt;</c>: <c>POST {baseUrl}/chat/completions</c> (Ollama, LM Studio, llama.cpp server, vLLM, company
/// gateways). The optional key is read from the vault per request and sent only as <c>Authorization: Bearer</c>. Prompt,
/// answer and key are never logged; error details carry the HTTP status and the server's short error message only.
/// </summary>
public sealed partial class OpenAiCompatibleProvider(string name, string baseUrl, string? defaultModel, Func<string?> key, HttpClient http)
    : IAiProvider
{
    private const int MaxDetail = 200;

    public string Id => AiProviderIds.OpenAi(name);

    public string BaseUrl => baseUrl;

    /// <summary><c>http://host:11434</c> and <c>http://host:11434/v1</c> both become <c>http://host:11434/v1</c>; a path ending in a version segment is kept.</summary>
    public static string ApiRoot(string baseUrl)
    {
        var trimmed = baseUrl.Trim().TrimEnd('/');
        var last = trimmed[(trimmed.LastIndexOf('/') + 1)..];
        return VersionSegmentRegex().IsMatch(last) && trimmed.Count(c => c == '/') > 2 ? trimmed : trimmed + "/v1";
    }

    public async Task<AiResult> CompleteAsync(AiRequest request, CancellationToken ct)
    {
        var model = request.Model ?? defaultModel;
        if (string.IsNullOrWhiteSpace(model))
        {
            return AiResult.Error(AiErrorKind.NotConfigured, "model");
        }

        var messages = new List<object>();
        if (!string.IsNullOrWhiteSpace(request.System))
        {
            messages.Add(new { role = "system", content = request.System });
        }

        messages.Add(new { role = "user", content = request.User });
        var body = JsonSerializer.Serialize(new { model, messages, stream = false });

        using var message = new HttpRequestMessage(HttpMethod.Post, ApiRoot(baseUrl) + "/chat/completions")
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
        var (status, json, error) = await SendAsync(message, request.Timeout, ct);
        return error is not null ? error with { Model = model } : ParseCompletion(status, json!, model);
    }

    /// <summary>
    /// <c>stream: true</c>: the answer arrives as server-sent events (<c>data: {choices[0].delta.content}</c> … <c>data: [DONE]</c>).
    /// A server that ignores <c>stream</c> and returns one JSON body is read like <see cref="CompleteAsync"/>.
    /// </summary>
    public async Task<AiResult> ChatAsync(AiChatRequest request, Action<string> onText, CancellationToken ct)
    {
        var model = request.Model ?? defaultModel;
        if (string.IsNullOrWhiteSpace(model))
        {
            return AiResult.Error(AiErrorKind.NotConfigured, "model");
        }

        var messages = new List<object>();
        if (!string.IsNullOrWhiteSpace(request.System))
        {
            messages.Add(new { role = "system", content = request.System });
        }

        messages.AddRange(request.Messages.Select(m => new { role = m.Role == AiChatRole.User ? "user" : "assistant", content = m.Text }));
        var body = JsonSerializer.Serialize(new { model, messages, stream = true });

        using var message = new HttpRequestMessage(HttpMethod.Post, ApiRoot(baseUrl) + "/chat/completions")
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
        message.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        var result = await SendAsync(message, request.Timeout, async (response, token) =>
        {
            if (response.Content.Headers.ContentType?.MediaType is "text/event-stream")
            {
                await using var stream = await response.Content.ReadAsStreamAsync(token);
                using var reader = new StreamReader(stream, Encoding.UTF8);
                return await ReadEventsAsync(reader, response.StatusCode, model, onText, token);
            }

            var text = await response.Content.ReadAsStringAsync(token);
            if (text.TrimStart().StartsWith("data:", StringComparison.Ordinal))
            {
                using var reader = new StringReader(text);
                return await ReadEventsAsync(reader, response.StatusCode, model, onText, token);
            }

            var answer = ParseCompletion(response.StatusCode, text, model);
            if (answer.IsOk)
            {
                onText(answer.Text!);
            }

            return answer;
        }, ct);
        return result.Model is null ? result with { Model = model } : result;
    }

    /// <summary><c>GET {baseUrl}/models</c> → <c>data[].id</c>, sorted.</summary>
    public async Task<AiModelList> ListModelsAsync(TimeSpan timeout, CancellationToken ct)
    {
        using var message = new HttpRequestMessage(HttpMethod.Get, ApiRoot(baseUrl) + "/models");
        var (_, json, error) = await SendAsync(message, timeout, ct);
        if (error is not null)
        {
            return new AiModelList([], error.ErrorKind, error.Detail);
        }

        try
        {
            using var doc = JsonDocument.Parse(json!);
            var ids = doc.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array
                ? data.EnumerateArray()
                    .Select(d => d.ValueKind == JsonValueKind.Object && d.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String ? id.GetString() : null)
                    .OfType<string>()
                    .Order(StringComparer.OrdinalIgnoreCase)
                    .ToList()
                : [];
            return new AiModelList(ids, AiErrorKind.None, null);
        }
        catch (JsonException)
        {
            return new AiModelList([], AiErrorKind.Failed, "not JSON");
        }
    }

    /// <summary>Reasoning models served through Ollama and others put their chain of thought in <c>&lt;think&gt;</c>.</summary>
    internal static string StripThinking(string text) => ThinkRegex().Replace(text, "").Trim();

    /// <summary>A partial answer as the user may see it: nothing while a leading <c>&lt;think&gt;</c> block is still open.</summary>
    internal static string VisiblePartial(string text)
    {
        var trimmed = text.TrimStart();
        if (!trimmed.StartsWith("<think>", StringComparison.Ordinal))
        {
            return trimmed;
        }

        var end = trimmed.IndexOf("</think>", StringComparison.Ordinal);
        return end < 0 ? "" : trimmed[(end + "</think>".Length)..].TrimStart();
    }

    private static AiResult ParseCompletion(HttpStatusCode status, string json, string model)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var content = root.TryGetProperty("choices", out var choices) && choices.ValueKind == JsonValueKind.Array && choices.GetArrayLength() > 0
                && choices[0].TryGetProperty("message", out var m) && m.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.String
                    ? c.GetString()
                    : null;
            var answered = root.TryGetProperty("model", out var am) && am.ValueKind == JsonValueKind.String ? am.GetString() : model;
            var text = StripThinking(content ?? "");
            return text.Length > 0
                ? AiResult.Ok(text, answered)
                : new AiResult(null, AiErrorKind.Failed, $"HTTP {(int)status}: no message content") { Model = answered };
        }
        catch (JsonException)
        {
            return new AiResult(null, AiErrorKind.Failed, $"HTTP {(int)status}: not JSON") { Model = model };
        }
    }

    /// <summary>
    /// Server-sent events: <c>data:</c> lines only (comments, <c>event:</c> and blank lines are skipped), each a chunk with
    /// <c>choices[0].delta.content</c>, until <c>[DONE]</c> or the end of the body. An <c>error</c> object fails the run.
    /// </summary>
    private static async Task<AiResult> ReadEventsAsync(TextReader reader, HttpStatusCode status, string model, Action<string> onText, CancellationToken ct)
    {
        var raw = new StringBuilder();
        var answered = model;
        var shown = "";
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (!line.StartsWith("data:", StringComparison.Ordinal))
            {
                continue;
            }

            var data = line["data:".Length..].Trim();
            if (data == "[DONE]")
            {
                break;
            }

            try
            {
                using var doc = JsonDocument.Parse(data);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                if (root.TryGetProperty("error", out var error) && error.ValueKind is JsonValueKind.Object or JsonValueKind.String)
                {
                    return new AiResult(null, AiErrorKind.Failed, Detail(status, data)) { Model = answered };
                }

                if (root.TryGetProperty("model", out var am) && am.ValueKind == JsonValueKind.String && am.GetString() is { Length: > 0 } m)
                {
                    answered = m;
                }

                if (root.TryGetProperty("choices", out var choices) && choices.ValueKind == JsonValueKind.Array && choices.GetArrayLength() > 0
                    && choices[0].TryGetProperty("delta", out var delta) && delta.ValueKind == JsonValueKind.Object
                    && delta.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.String && c.GetString() is { Length: > 0 } piece)
                {
                    raw.Append(piece);
                    var visible = VisiblePartial(raw.ToString());
                    if (visible.Length > 0 && visible != shown)
                    {
                        shown = visible;
                        onText(visible);
                    }
                }
            }
            catch (JsonException)
            {
                // A keep-alive or vendor extension that is not JSON: skip it.
            }
        }

        var text = StripThinking(raw.ToString());
        return text.Length > 0
            ? AiResult.Ok(text, answered)
            : new AiResult(null, AiErrorKind.Failed, $"HTTP {(int)status}: no message content") { Model = answered };
    }

    private async Task<(HttpStatusCode Status, string? Json, AiResult? Error)> SendAsync(HttpRequestMessage message, TimeSpan timeout, CancellationToken ct)
    {
        HttpStatusCode status = 0;
        string? json = null;
        var result = await SendAsync(message, timeout, async (response, token) =>
        {
            status = response.StatusCode;
            json = await response.Content.ReadAsStringAsync(token);
            return new AiResult(null, AiErrorKind.None, null);
        }, ct);
        return result.ErrorKind == AiErrorKind.None ? (status, json, null) : (status, null, result);
    }

    /// <summary>
    /// Sends with the key and the timeout, maps HTTP and connection errors, and hands a 2xx response to
    /// <paramref name="read"/> as soon as its headers are in (so an answer can be streamed).
    /// </summary>
    private async Task<AiResult> SendAsync(
        HttpRequestMessage message, TimeSpan timeout, Func<HttpResponseMessage, CancellationToken, Task<AiResult>> read, CancellationToken ct)
    {
        if (key() is { Length: > 0 } secret)
        {
            message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", secret);
        }

        message.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        using var timer = new CancellationTokenSource(timeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timer.Token);
        try
        {
            using var response = await http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, linked.Token);
            if (!response.IsSuccessStatusCode)
            {
                var text = await response.Content.ReadAsStringAsync(linked.Token);
                var kind = response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden ? AiErrorKind.Unauthorized : AiErrorKind.Failed;
                return AiResult.Error(kind, Detail(response.StatusCode, text));
            }

            return await read(response, linked.Token);
        }
        catch (Exception ex) when ((ex is OperationCanceledException or IOException or ObjectDisposedException or HttpRequestException)
                                   && linked.IsCancellationRequested)
        {
            // Cancelling a read in the middle of a body may surface as an I/O error instead of a cancellation.
            return AiResult.Error(ct.IsCancellationRequested ? AiErrorKind.Cancelled : AiErrorKind.Timeout);
        }
        catch (HttpRequestException ex) when (ex.InnerException is SocketException or AuthenticationException or IOException || ex.HttpRequestError
                                                   is HttpRequestError.ConnectionError or HttpRequestError.NameResolutionError or HttpRequestError.SecureConnectionError)
        {
            return AiResult.Error(AiErrorKind.Unreachable, ex.HttpRequestError.ToString());
        }
        catch (HttpRequestException ex)
        {
            return AiResult.Error(AiErrorKind.Failed, ex.HttpRequestError.ToString());
        }
        catch (OperationCanceledException)
        {
            return AiResult.Error(AiErrorKind.Timeout);
        }
        catch (IOException)
        {
            // The connection dropped in the middle of a streamed answer.
            return AiResult.Error(AiErrorKind.Failed, "connectionLost");
        }
    }

    /// <summary>"HTTP 404: model not found" – the server's <c>error.message</c> (or <c>error</c> string), first line, cut short.</summary>
    private static string Detail(HttpStatusCode status, string body)
    {
        string? message = null;
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("error", out var e))
            {
                message = e.ValueKind switch
                {
                    JsonValueKind.String => e.GetString(),
                    JsonValueKind.Object when e.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String => m.GetString(),
                    _ => null,
                };
            }
        }
        catch (JsonException)
        {
        }

        var line = CliProcess.FirstLine(message ?? "");
        line = line.Length > MaxDetail ? line[..MaxDetail] + "…" : line;
        return line.Length > 0 ? $"HTTP {(int)status}: {line}" : $"HTTP {(int)status}";
    }

    [GeneratedRegex(@"^v\d+[a-z]*$")]
    private static partial Regex VersionSegmentRegex();

    [GeneratedRegex(@"^\s*<think>.*?</think>", RegexOptions.Singleline)]
    private static partial Regex ThinkRegex();
}
