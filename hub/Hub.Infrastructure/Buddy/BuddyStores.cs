using System.Text.Json;
using Hub.Infrastructure.Data;
using Dapper;

namespace Hub.Infrastructure.Buddy;

public sealed record BuddyChat(string SessionId, string Title, string? Model, bool Pinned, DateTimeOffset UpdatedAt);

/// <summary><c>buddy_chats</c>: title, model and time per Claude session; never message content (spec §17.3).</summary>
public sealed class BuddyChatRepository(Database db)
{
    public const int TitleLength = 60;

    /// <summary>Creates the row on the first answer; later calls only move <c>updated_at</c> and the model.</summary>
    public void Touch(string sessionId, string firstUserMessage, string? model, DateTimeOffset at)
    {
        using var c = db.Open();
        c.Execute(
            """
            INSERT INTO buddy_chats (claude_session_id, title, model, updated_at) VALUES (@sessionId, @title, @model, @at)
            ON CONFLICT(claude_session_id) DO UPDATE SET updated_at = @at, model = COALESCE(@model, model)
            """,
            new { sessionId, title = Title(firstUserMessage), model, at = at.ToUnixTimeMilliseconds() });
    }

    public IReadOnlyList<BuddyChat> List(int limit)
    {
        using var c = db.Open();
        return c.Query<(string Id, string Title, string? Model, long Pinned, long At)>(
                "SELECT claude_session_id, title, model, pinned, updated_at FROM buddy_chats ORDER BY pinned DESC, updated_at DESC LIMIT @limit",
                new { limit })
            .Select(r => new BuddyChat(r.Id, r.Title, r.Model, r.Pinned != 0, DateTimeOffset.FromUnixTimeMilliseconds(r.At)))
            .ToList();
    }

    public void SetPinned(string sessionId, bool pinned)
    {
        using var c = db.Open();
        c.Execute("UPDATE buddy_chats SET pinned = @p WHERE claude_session_id = @sessionId", new { sessionId, p = pinned ? 1 : 0 });
    }

    /// <summary>Removes the list entry only; Claude's transcript is left alone.</summary>
    public void Forget(string sessionId)
    {
        using var c = db.Open();
        c.Execute("DELETE FROM buddy_chats WHERE claude_session_id = @sessionId", new { sessionId });
    }

    /// <summary>First line of the first message, whitespace collapsed, at most <see cref="TitleLength"/> characters.</summary>
    public static string Title(string message)
    {
        var line = message.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault() ?? "";
        line = string.Join(' ', line.Split(' ', StringSplitOptions.RemoveEmptyEntries));
        return line.Length <= TitleLength ? line : line[..(TitleLength - 1)].TrimEnd() + "…";
    }
}

public sealed record BuddyMessage(bool FromUser, string Text);

/// <summary>
/// Reads an old Bip chat back from Claude Code's transcript to show it again (spec §17.3). The text only goes to the
/// window; nothing is copied into the hub's database or logs.
/// </summary>
public sealed class BuddyTranscriptReader(string claudeProjectsDir)
{
    public string? FindTranscript(string sessionId)
    {
        if (!Directory.Exists(claudeProjectsDir) || sessionId.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
        {
            return null;
        }

        return Directory.EnumerateFiles(claudeProjectsDir, sessionId + ".jsonl", SearchOption.AllDirectories).FirstOrDefault();
    }

    public IReadOnlyList<BuddyMessage> Read(string sessionId)
    {
        var path = FindTranscript(sessionId);
        if (path is null)
        {
            return [];
        }

        var messages = new List<BuddyMessage>();
        string? lastAssistantId = null;
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(stream);
        while (reader.ReadLine() is { } line)
        {
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                if (root.TryGetProperty("isMeta", out var meta) && meta.ValueKind == JsonValueKind.True)
                {
                    continue;
                }

                if (!root.TryGetProperty("message", out var message) || message.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var type = root.TryGetProperty("type", out var t) ? t.GetString() : null;
                var text = Text(message);
                if (string.IsNullOrWhiteSpace(text))
                {
                    continue;
                }

                if (type == "user")
                {
                    messages.Add(new BuddyMessage(true, text));
                    lastAssistantId = null;
                }
                else if (type == "assistant")
                {
                    // Claude Code writes one line per content block of the same message: join them.
                    var id = message.TryGetProperty("id", out var i) ? i.GetString() : null;
                    if (id is not null && id == lastAssistantId && messages.Count > 0 && !messages[^1].FromUser)
                    {
                        messages[^1] = messages[^1] with { Text = messages[^1].Text + "\n\n" + text };
                    }
                    else
                    {
                        messages.Add(new BuddyMessage(false, text));
                    }

                    lastAssistantId = id;
                }
            }
            catch (JsonException)
            {
            }
        }

        return messages;
    }

    /// <summary>A string content, or the text blocks of an array content (tool and thinking blocks are skipped).</summary>
    private static string Text(JsonElement message)
    {
        if (!message.TryGetProperty("content", out var content))
        {
            return "";
        }

        return content.ValueKind switch
        {
            JsonValueKind.String => content.GetString() ?? "",
            JsonValueKind.Array => string.Join("\n\n", content.EnumerateArray()
                .Where(b => b.ValueKind == JsonValueKind.Object && b.TryGetProperty("type", out var bt) && bt.GetString() == "text")
                .Select(b => b.TryGetProperty("text", out var tx) ? tx.GetString() ?? "" : "")
                .Where(s => s.Length > 0)),
            _ => "",
        };
    }
}

/// <summary>Finds the <c>claude</c> CLI without running it (spec §17.1): PATH, then the native installer's folder.</summary>
public static class ClaudeCliLocator
{
    public static string? Find(string? pathVariable = null, string? userProfile = null) =>
        Ai.CliAgentLocator.Find(Core.Ai.CliAgentSpecs.ClaudeCode, pathVariable, userProfile);
}
