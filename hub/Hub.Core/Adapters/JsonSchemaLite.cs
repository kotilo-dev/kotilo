using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Hub.Core.Adapters;

/// <summary>
/// The subset of JSON Schema the Kotilo schemas use (<c>const</c>, <c>type</c>, <c>enum</c>, <c>pattern</c>,
/// <c>minLength</c>/<c>maxLength</c>, <c>minimum</c>/<c>maximum</c>, <c>items</c>, <c>required</c>, <c>properties</c>,
/// <c>additionalProperties: false</c>). No validator dependency; <c>$ref</c>, <c>oneOf</c> and friends are not supported.
/// </summary>
public static class JsonSchemaLite
{
    private static readonly TimeSpan PatternTimeout = TimeSpan.FromMilliseconds(200);

    /// <summary>Validation errors as <c>$.path: message</c>; empty when <paramref name="value"/> matches.</summary>
    public static IReadOnlyList<string> Validate(JsonElement value, JsonElement schema)
    {
        var errors = new List<string>();
        Validate(value, schema, "$", errors);
        return errors;
    }

    private static void Validate(JsonElement value, JsonElement schema, string path, List<string> errors)
    {
        if (schema.TryGetProperty("const", out var constant) && value.GetRawText() != constant.GetRawText())
        {
            errors.Add($"{path}: expected {constant.GetRawText()}");
        }

        if (schema.TryGetProperty("enum", out var choices) && choices.ValueKind == JsonValueKind.Array
            && !choices.EnumerateArray().Any(c => c.GetRawText() == value.GetRawText()))
        {
            errors.Add($"{path}: expected one of {string.Join(", ", choices.EnumerateArray().Select(c => c.GetRawText()))}");
            return;
        }

        if (schema.TryGetProperty("type", out var type) && !HasType(value, type))
        {
            errors.Add($"{path}: expected {type.GetRawText().Trim('"')}");
            return;
        }

        switch (value.ValueKind)
        {
            case JsonValueKind.String:
                var s = value.GetString()!;
                if (schema.TryGetProperty("pattern", out var pattern) && !Matches(s, pattern.GetString()!))
                {
                    errors.Add($"{path}: '{s}' does not match {pattern.GetString()}");
                }

                if ((schema.TryGetProperty("minLength", out var min) && s.Length < min.GetInt32())
                    || (schema.TryGetProperty("maxLength", out var max) && s.Length > max.GetInt32()))
                {
                    errors.Add(string.Create(CultureInfo.InvariantCulture, $"{path}: length {s.Length} out of range"));
                }

                break;

            case JsonValueKind.Number:
                if (schema.TryGetProperty("minimum", out var minimum) && value.GetDouble() < minimum.GetDouble())
                {
                    errors.Add(string.Create(CultureInfo.InvariantCulture, $"{path}: below {minimum.GetDouble()}"));
                }

                if (schema.TryGetProperty("maximum", out var maximum) && value.GetDouble() > maximum.GetDouble())
                {
                    errors.Add(string.Create(CultureInfo.InvariantCulture, $"{path}: above {maximum.GetDouble()}"));
                }

                break;

            case JsonValueKind.Array:
                if (schema.TryGetProperty("items", out var items))
                {
                    var i = 0;
                    foreach (var item in value.EnumerateArray())
                    {
                        Validate(item, items, string.Create(CultureInfo.InvariantCulture, $"{path}[{i++}]"), errors);
                    }
                }

                break;

            case JsonValueKind.Object:
                var properties = schema.TryGetProperty("properties", out var p) ? p : default;
                if (schema.TryGetProperty("required", out var required))
                {
                    errors.AddRange(required.EnumerateArray().Select(r => r.GetString()!)
                        .Where(r => !value.TryGetProperty(r, out _)).Select(r => $"{path}: missing '{r}'"));
                }

                foreach (var property in value.EnumerateObject())
                {
                    if (properties.ValueKind == JsonValueKind.Object && properties.TryGetProperty(property.Name, out var sub))
                    {
                        Validate(property.Value, sub, $"{path}.{property.Name}", errors);
                    }
                    else if (schema.TryGetProperty("additionalProperties", out var extra) && extra.ValueKind == JsonValueKind.False)
                    {
                        errors.Add($"{path}: unknown property '{property.Name}'");
                    }
                }

                break;

            default:
                break;
        }
    }

    private static bool Matches(string value, string pattern)
    {
        try
        {
            return Regex.IsMatch(value, pattern, RegexOptions.None, PatternTimeout);
        }
        catch (RegexMatchTimeoutException)
        {
            return false;
        }
    }

    private static bool HasType(JsonElement value, JsonElement type) => type.ValueKind == JsonValueKind.Array
        ? type.EnumerateArray().Any(t => HasType(value, t.GetString()!))
        : HasType(value, type.GetString()!);

    private static bool HasType(JsonElement value, string type) => type switch
    {
        "object" => value.ValueKind == JsonValueKind.Object,
        "array" => value.ValueKind == JsonValueKind.Array,
        "string" => value.ValueKind == JsonValueKind.String,
        "integer" => value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out _),
        "number" => value.ValueKind == JsonValueKind.Number,
        "boolean" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
        "null" => value.ValueKind == JsonValueKind.Null,
        _ => true,
    };
}
