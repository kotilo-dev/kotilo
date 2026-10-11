using System.Text;

namespace Hub.Core.Buddy;

public enum InlineStyle
{
    Plain,
    Bold,
    Italic,
    Code,
}

public sealed record MdInline(string Text, InlineStyle Style);

public abstract record MdBlock
{
    public sealed record Paragraph(IReadOnlyList<MdInline> Inlines) : MdBlock;

    public sealed record Heading(int Level, IReadOnlyList<MdInline> Inlines) : MdBlock;

    /// <param name="Marker">"•" or "3." as written.</param>
    public sealed record ListItem(int Indent, string Marker, IReadOnlyList<MdInline> Inlines) : MdBlock;

    public sealed record Code(string? Language, string Text) : MdBlock;

    public sealed record Quote(IReadOnlyList<MdInline> Inlines) : MdBlock;
}

/// <summary>
/// The markdown subset chat answers need (spec §17.4): headings, paragraphs, bullet / numbered lists, block quotes,
/// fenced code (an unclosed fence while streaming is still a code block), inline code, bold and italic. Links keep their
/// text. Everything else is plain text, so nothing is ever lost.
/// </summary>
public static class MarkdownLite
{
    public static IReadOnlyList<MdBlock> Parse(string markdown)
    {
        var blocks = new List<MdBlock>();
        var paragraph = new List<string>();
        string? fenceLang = null;
        StringBuilder? code = null;

        foreach (var raw in markdown.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n'))
        {
            var trimmed = raw.TrimStart();
            if (code is not null)
            {
                if (trimmed.StartsWith("```", StringComparison.Ordinal))
                {
                    blocks.Add(new MdBlock.Code(fenceLang, code.ToString().TrimEnd('\n')));
                    code = null;
                }
                else
                {
                    code.Append(raw).Append('\n');
                }

                continue;
            }

            if (trimmed.StartsWith("```", StringComparison.Ordinal))
            {
                Flush();
                var lang = trimmed[3..].Trim();
                fenceLang = lang.Length == 0 ? null : lang;
                code = new StringBuilder();
                continue;
            }

            if (trimmed.Length == 0)
            {
                Flush();
                continue;
            }

            var hashes = trimmed.TakeWhile(c => c == '#').Count();
            if (hashes is >= 1 and <= 6 && trimmed.Length > hashes && trimmed[hashes] == ' ')
            {
                Flush();
                blocks.Add(new MdBlock.Heading(hashes, Inlines(trimmed[(hashes + 1)..].Trim())));
                continue;
            }

            if (trimmed.StartsWith("> ", StringComparison.Ordinal) || trimmed == ">")
            {
                Flush();
                blocks.Add(new MdBlock.Quote(Inlines(trimmed.TrimStart('>').Trim())));
                continue;
            }

            if (TryListItem(raw, out var indent, out var marker, out var text))
            {
                Flush();
                blocks.Add(new MdBlock.ListItem(indent, marker, Inlines(text)));
                continue;
            }

            paragraph.Add(trimmed);
        }

        // An open fence while the answer is still streaming renders as code so far.
        if (code is not null)
        {
            blocks.Add(new MdBlock.Code(fenceLang, code.ToString().TrimEnd('\n')));
        }

        Flush();
        return blocks;

        void Flush()
        {
            if (paragraph.Count > 0)
            {
                blocks.Add(new MdBlock.Paragraph(Inlines(string.Join(' ', paragraph))));
                paragraph.Clear();
            }
        }
    }

    public static IReadOnlyList<MdInline> Inlines(string text)
    {
        var result = new List<MdInline>();
        var plain = new StringBuilder();
        var i = 0;
        while (i < text.Length)
        {
            if (text[i] == '`' && Close(text, i + 1, "`") is { } codeEnd)
            {
                Emit(text[(i + 1)..codeEnd], InlineStyle.Code);
                i = codeEnd + 1;
            }
            else if ((Starts(text, i, "**") || Starts(text, i, "__")) && Close(text, i + 2, text.Substring(i, 2)) is { } boldEnd && boldEnd > i + 2)
            {
                Emit(text[(i + 2)..boldEnd], InlineStyle.Bold);
                i = boldEnd + 2;
            }
            else if (text[i] is '*' or '_' && i + 1 < text.Length && text[i + 1] != ' '
                && (i == 0 || !char.IsLetterOrDigit(text[i - 1]))
                && Close(text, i + 1, text[i].ToString()) is { } italicEnd && italicEnd > i + 1)
            {
                Emit(text[(i + 1)..italicEnd], InlineStyle.Italic);
                i = italicEnd + 1;
            }
            else if (text[i] == '[' && Close(text, i + 1, "](") is { } labelEnd && Close(text, labelEnd + 2, ")") is { } linkEnd)
            {
                // Links: keep the label; the chat never opens URLs on its own.
                plain.Append(text, i + 1, labelEnd - i - 1);
                i = linkEnd + 1;
            }
            else
            {
                plain.Append(text[i]);
                i++;
            }
        }

        if (plain.Length > 0)
        {
            result.Add(new MdInline(plain.ToString(), InlineStyle.Plain));
        }

        return result;

        void Emit(string content, InlineStyle style)
        {
            if (plain.Length > 0)
            {
                result.Add(new MdInline(plain.ToString(), InlineStyle.Plain));
                plain.Clear();
            }

            result.Add(new MdInline(content, style));
        }
    }

    /// <summary>Plain text of a whole answer for "Kopyala" (markdown kept as written).</summary>
    public static string ToPlainText(IReadOnlyList<MdInline> inlines) => string.Concat(inlines.Select(i => i.Text));

    private static bool TryListItem(string raw, out int indent, out string marker, out string text)
    {
        indent = raw.Length - raw.TrimStart().Length;
        var t = raw.TrimStart();
        marker = "";
        text = "";
        if (t.Length >= 2 && t[0] is '-' or '*' or '+' && t[1] == ' ')
        {
            marker = "•";
            text = t[2..].Trim();
            return true;
        }

        var digits = t.TakeWhile(char.IsAsciiDigit).Count();
        if (digits > 0 && digits + 1 < t.Length && t[digits] is '.' or ')' && t[digits + 1] == ' ')
        {
            marker = t[..(digits + 1)];
            text = t[(digits + 2)..].Trim();
            return true;
        }

        return false;
    }

    private static bool Starts(string s, int at, string token) => string.CompareOrdinal(s, at, token, 0, token.Length) == 0;

    private static int? Close(string s, int from, string token)
    {
        if (from >= s.Length)
        {
            return null;
        }

        var idx = s.IndexOf(token, from, StringComparison.Ordinal);
        return idx < 0 ? null : idx;
    }
}
