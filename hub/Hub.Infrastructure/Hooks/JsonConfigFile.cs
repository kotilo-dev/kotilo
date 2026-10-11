using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Hub.Infrastructure.Hooks;

/// <summary>
/// An agent's JSON config file, read and written the backup-first way (AGENTS.md rule 4): a missing or blank file reads
/// as <c>{}</c>, a file that can't be parsed throws (and is never rewritten), and every write first copies the old file
/// to <c>&lt;file&gt;.&lt;exePrefix&gt;-backup-&lt;yyyyMMdd-HHmmss&gt;</c>, then replaces it atomically.
/// </summary>
/// <param name="allowComments">
/// JSONC tolerance (comments, trailing commas) for agents that read their file that way. Comments are not kept on rewrite;
/// the backup has them.
/// </param>
public sealed class JsonConfigFile(string path, bool allowComments, TimeProvider? time = null)
{
    private static readonly JsonSerializerOptions WriteOptions = new() { WriteIndented = true, IndentSize = 2 };

    private readonly TimeProvider _time = time ?? TimeProvider.System;

    public string Path => path;

    public bool Exists => File.Exists(path);

    /// <exception cref="JsonException">The file is not valid JSON.</exception>
    /// <exception cref="InvalidDataException">The file is JSON but not an object.</exception>
    public JsonObject Load()
    {
        if (!File.Exists(path))
        {
            return [];
        }

        var text = File.ReadAllText(path);
        if (string.IsNullOrWhiteSpace(text))
        {
            return [];
        }

        var options = allowComments
            ? new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true }
            : default;

        // Invalid JSON throws: never overwrite a file we could not understand.
        return JsonNode.Parse(text, documentOptions: options) as JsonObject
            ?? throw new InvalidDataException($"{path} is not a JSON object.");
    }

    /// <summary>Writes <paramref name="root"/>; returns the backup path, or null when there was no file to back up.</summary>
    public string? Save(JsonObject root)
    {
        var backup = Backup();
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
        var temp = path + ".agenthub-tmp";
        File.WriteAllText(temp, root.ToJsonString(WriteOptions) + Environment.NewLine, new UTF8Encoding(false));
        File.Move(temp, path, overwrite: true);
        return backup;
    }

    /// <summary>Removes the file (an agent-hub-owned file that became empty); returns the backup path.</summary>
    public string? Delete()
    {
        var backup = Backup();
        File.Delete(path);
        return backup;
    }

    private string? Backup()
    {
        if (!File.Exists(path))
        {
            return null;
        }

        var stamp = _time.GetLocalNow().ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
        var backup = $"{path}.{Hub.Core.Brand.Current.ExePrefix}-backup-{stamp}";
        File.Copy(path, backup, overwrite: true);
        return backup;
    }
}
