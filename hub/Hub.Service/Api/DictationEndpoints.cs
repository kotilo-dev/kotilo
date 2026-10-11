using Hub.Service.Hosting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Routing;

namespace Hub.Service.Api;

public sealed record DictationTranscribeDto(string Status, string RawText, double SpeechSeconds, string Model, string Language);

public sealed record DictationCleanupBody(string? Text);

public sealed record DictationCleanupDto(string FinalText, bool Cleaned, string? Note);

public sealed record DictationSaveBody(double? DurationSeconds, string? RawText, string? FinalText, bool? Cleaned, IReadOnlyList<string>? Outputs);

public sealed record DictationSavedDto(long? Id, IReadOnlyList<string> Outputs, string? FileError);

/// <summary>Live dictation (M2b, docs/hub-api.md): the desktop app records and inserts, the hub transcribes and keeps history.</summary>
internal static class DictationEndpoints
{
    public const string PcmContentType = "application/octet-stream";

    private static readonly string[] DesktopOutputs = ["type", "clipboard"];

    public static void Map(IEndpointRouteBuilder app, DictationService dictation)
    {
        app.MapPost("/v1/dictation/preload", () =>
            dictation.Preload() ? Results.StatusCode(StatusCodes.Status202Accepted) : ModelMissing());

        app.MapPost("/v1/dictation/transcribe", async (HttpContext context) =>
        {
            var request = context.Request;
            if (!string.Equals(request.ContentType?.Split(';')[0].Trim(), PcmContentType, StringComparison.OrdinalIgnoreCase))
            {
                return ApiJson.Error(StatusCodes.Status415UnsupportedMediaType, "invalidRequest", $"The body must be {PcmContentType}: f32 LE mono samples at 16 kHz.");
            }

            var limit = dictation.MaxBodyBytes;
            if (request.ContentLength > limit)
            {
                return TooLarge(limit);
            }

            if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } size)
            {
                size.MaxRequestBodySize = limit;
            }

            byte[] body;
            try
            {
                using var buffer = new MemoryStream();
                await request.Body.CopyToAsync(buffer, context.RequestAborted);
                body = buffer.ToArray();
            }
            catch (BadHttpRequestException ex) when (ex.StatusCode == StatusCodes.Status413PayloadTooLarge)
            {
                return TooLarge(limit);
            }

            if (body.Length % sizeof(float) != 0)
            {
                return ApiJson.BadRequest("The body length must be a multiple of 4 (f32 samples).");
            }

            var result = await dictation.TranscribeAsync(body, context.RequestAborted);
            return result.Status switch
            {
                DictationStatus.ModelMissing => ModelMissing(),
                DictationStatus.Busy => ApiJson.Error(StatusCodes.Status409Conflict, "busy", "Another dictation is being transcribed."),
                _ => ApiJson.Ok(new DictationTranscribeDto(
                    result.Status switch
                    {
                        DictationStatus.Ok => "ok",
                        DictationStatus.NoSpeech => "noSpeech",
                        _ => "cancelled",
                    },
                    result.RawText,
                    Math.Round(result.SpeechSeconds, 2),
                    result.Model,
                    result.Language)),
            };
        });

        app.MapPost("/v1/dictation/cleanup", async (HttpRequest request) =>
        {
            var (body, error) = await ApiJson.ReadAsync<DictationCleanupBody>(request);
            if (error is not null)
            {
                return error;
            }

            if (body!.Text is null)
            {
                return ApiJson.BadRequest("'text' is required.", new Dictionary<string, string[]> { ["text"] = ["required"] });
            }

            var result = await dictation.CleanupAsync(body.Text, request.HttpContext.RequestAborted);
            return ApiJson.Ok(new DictationCleanupDto(result.FinalText, result.Cleaned, result.Note));
        });

        app.MapPost("/v1/dictation/cancel", () =>
        {
            dictation.Cancel();
            return Results.NoContent();
        });

        app.MapPost("/v1/dictations", async (HttpRequest request) =>
        {
            var (body, error) = await ApiJson.ReadAsync<DictationSaveBody>(request);
            if (error is not null)
            {
                return error;
            }

            var fields = new Dictionary<string, string[]>();
            if (body!.DurationSeconds is not >= 0)
            {
                fields["durationSeconds"] = [">= 0"];
            }

            if (body.RawText is null)
            {
                fields["rawText"] = ["required"];
            }

            if (string.IsNullOrWhiteSpace(body.FinalText))
            {
                fields["finalText"] = ["required"];
            }

            if (body.Outputs?.Any(o => !DesktopOutputs.Contains(o)) == true)
            {
                fields["outputs"] = ["type | clipboard"];
            }

            if (fields.Count > 0)
            {
                return ApiJson.BadRequest("The dictation is not valid.", fields);
            }

            var saved = await dictation.SaveAsync(new DictationDelivery(
                body.DurationSeconds!.Value, body.RawText!, body.FinalText!, body.Cleaned ?? false, body.Outputs ?? []));
            return ApiJson.Ok(new DictationSavedDto(saved.Id, saved.Outputs, saved.FileError));
        });
    }

    private static IResult ModelMissing() =>
        ApiJson.Error(StatusCodes.Status409Conflict, "modelMissing", "The selected Whisper model is not installed.");

    private static IResult TooLarge(long limit) =>
        ApiJson.Error(StatusCodes.Status413PayloadTooLarge, "tooLarge", $"At most {limit} bytes (the maximum recording length).");
}
