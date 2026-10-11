using System.Text.Json;
using System.Text.Json.Serialization;

namespace Hub.Contracts;

/// <summary>Constants of the hub's loopback API (ARCHITECTURE §5).</summary>
public static class HubApi
{
    /// <summary>Every request must carry the token from <see cref="PortFile"/> in this header.</summary>
    public const string TokenHeader = "X-AgentHub-Token";

    /// <summary>Written to the hub data folder once the server listens; deleted on clean shutdown.</summary>
    public const string PortFileName = "port.json";

    public const int PortFileVersion = 1;
}

/// <summary>Contents of <c>port.json</c>: where the hub listens and the token clients must send.</summary>
public sealed record PortFile(
    [property: JsonPropertyName("v")] int Version,
    [property: JsonPropertyName("port")] int Port,
    [property: JsonPropertyName("token")] string Token,
    [property: JsonPropertyName("pid")] int Pid)
{
    public string ToJson() => JsonSerializer.Serialize(this, PortFileJsonContext.Default.PortFile);

    /// <returns>Null when the text is not a valid port file.</returns>
    public static PortFile? Parse(string json)
    {
        try
        {
            var file = JsonSerializer.Deserialize(json, PortFileJsonContext.Default.PortFile);
            return file is { Port: > 0 and < 65536, Token.Length: > 0 } ? file : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

[JsonSerializable(typeof(PortFile))]
internal sealed partial class PortFileJsonContext : JsonSerializerContext;
