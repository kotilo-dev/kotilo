using System.Text.Json;
using Hub.Core.Adapters;

namespace Hub.Core.Hooks;

/// <summary>
/// Envelope → normalized <see cref="HookEvent"/>: parses hook envelope v1 and hands it to the adapter it names in the
/// given (live) registry. Unknown fields are ignored and missing fields never throw.
/// </summary>
public static class HookEventParser
{
    public static HookEvent? Parse(ReadOnlySpan<byte> json, AdapterRegistry adapters, out HookParseError error)
    {
        var envelope = HookEnvelope.Parse(json, out error);
        return envelope is null ? null : Map(envelope, adapters, out error);
    }

    public static HookEvent? ParseEnvelope(JsonElement root, AdapterRegistry adapters, out HookParseError error)
    {
        var envelope = HookEnvelope.FromElement(root, out error);
        return envelope is null ? null : Map(envelope, adapters, out error);
    }

    private static HookEvent? Map(HookEnvelope envelope, AdapterRegistry adapters, out HookParseError error)
    {
        if (envelope.Version != HookEnvelope.CurrentVersion)
        {
            error = HookParseError.UnsupportedVersion;
            return null;
        }

        if (adapters.Find(envelope.Agent) is not { } adapter)
        {
            error = HookParseError.UnknownAgent;
            return null;
        }

        // Adapters return null only when the payload has no session id (and, for the protocol, no pane either).
        var e = adapter.Map(envelope);
        error = e is null ? HookParseError.MissingSessionId : HookParseError.None;
        return e;
    }
}
