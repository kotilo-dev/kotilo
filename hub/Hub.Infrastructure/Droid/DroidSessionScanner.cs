using System.Text;
using Hub.Core.Adapters;
using Hub.Core.Usage;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Droid;

/// <summary>
/// The Factory Droid usage source: <c>~/.factory/sessions/**/&lt;id&gt;.settings.json</c> (<see cref="DroidSessionUsage"/>).
/// The file is rewritten with running totals, so each change becomes one entry with the difference to the totals seen
/// last time. Those totals live in <see cref="TranscriptOffsetStore"/> next to the file's own row: <c>&lt;path&gt;</c> keeps the
/// last write time (and the total sum), <c>&lt;path&gt;#&lt;field&gt;</c> each counter. No prices are shipped for Droid; a model
/// that is in the price table gets priced like any other entry. Not thread-safe; callers serialize passes.
/// </summary>
public sealed class DroidSessionScanner(string sessionsDir, UsageSourceContext context) : IFileUsageSource
{
    public const string Pattern = "*" + DroidSessionUsage.SettingsSuffix;

    /// <summary>The transcript's first line is short; anything longer is not a <c>session_start</c> record we can use.</summary>
    private const int MaxFirstLineBytes = 64 * 1024;

    public string Agent => AgentIds.Droid;

    public IReadOnlyList<string> WatchDirs => [sessionsDir];

    public string FilePattern => Pattern;

    public bool ReportsActivity => false;

    public bool Owns(string path) =>
        TranscriptScanner.IsUnder(path, sessionsDir) && path.EndsWith(DroidSessionUsage.SettingsSuffix, StringComparison.OrdinalIgnoreCase);

    public ScanResult ScanAll(DateTime since)
    {
        if (!Directory.Exists(sessionsDir))
        {
            return ScanResult.Empty;
        }

        var known = context.Offsets.GetAll();
        var total = ScanResult.Empty;
        foreach (var path in Directory.EnumerateFiles(sessionsDir, Pattern, SearchOption.AllDirectories))
        {
            DateTime lastWrite;
            try
            {
                lastWrite = File.GetLastWriteTimeUtc(path);
            }
            catch (IOException)
            {
                continue;
            }

            if (lastWrite < since || (known.TryGetValue(path, out var stored) && stored.LastWriteUtc == lastWrite))
            {
                continue;
            }

            total = total.Add(ScanFile(path));
        }

        return total;
    }

    public ScanResult ScanFile(string path)
    {
        if (DroidSessionUsage.SessionIdFromFileName(path) is not { } sessionId)
        {
            return ScanResult.Empty;
        }

        string json;
        DateTime lastWrite;
        try
        {
            if (!File.Exists(path))
            {
                return ScanResult.Empty;
            }

            lastWrite = File.GetLastWriteTimeUtc(path);
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            json = reader.ReadToEnd();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return ScanResult.Empty;
        }

        if (DroidSessionUsage.Parse(json) is not { } parsed)
        {
            return ScanResult.Empty;
        }

        var previous = LoadTotals(path);
        var delta = DroidSessionUsage.Delta(previous, parsed.Totals);
        var entries = new List<UsageEntry>();
        if (delta is not null && delta.Input + delta.Output + delta.CacheCreation + delta.CacheRead > 0)
        {
            var at = new DateTimeOffset(DateTime.SpecifyKind(lastWrite, DateTimeKind.Utc));
            entries.Add(DroidSessionUsage.Entry(sessionId, parsed.Model, delta, parsed.Totals, at, ProjectRoot(path, sessionId)));
        }

        var written = context.Store(entries, Agent);
        SaveTotals(path, parsed.Totals, lastWrite);
        return new ScanResult(1, entries.Count, written, 0, 0);
    }

    private DroidTokenTotals? LoadTotals(string path)
    {
        if (context.Offsets.Get(path) is null)
        {
            return null;
        }

        var values = new long[DroidTokenTotals.FieldNames.Count];
        for (var i = 0; i < values.Length; i++)
        {
            values[i] = context.Offsets.Get(FieldKey(path, i))?.Offset ?? 0;
        }

        return DroidTokenTotals.FromArray(values);
    }

    private void SaveTotals(string path, DroidTokenTotals totals, DateTime lastWrite)
    {
        var values = totals.ToArray();
        for (var i = 0; i < values.Length; i++)
        {
            context.Offsets.Set(FieldKey(path, i), new TranscriptOffset(values[i], lastWrite));
        }

        // Written last: its presence means the counters above are complete.
        context.Offsets.Set(path, new TranscriptOffset(totals.Sum, lastWrite));
    }

    private static string FieldKey(string path, int field) => $"{path}#{DroidTokenTotals.FieldNames[field]}";

    /// <summary>The <c>cwd</c> from the first line of the sibling <c>&lt;id&gt;.jsonl</c>; null when it can't be read.</summary>
    private static string? ProjectRoot(string settingsPath, string sessionId)
    {
        var transcript = Path.Combine(Path.GetDirectoryName(settingsPath)!, sessionId + ".jsonl");
        try
        {
            if (!File.Exists(transcript))
            {
                return null;
            }

            using var stream = new FileStream(transcript, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var buffer = new byte[MaxFirstLineBytes];
            var read = stream.ReadAtLeast(buffer, buffer.Length, throwOnEndOfStream: false);
            var end = Array.IndexOf(buffer, (byte)'\n', 0, read);
            if (end < 0 && read == buffer.Length)
            {
                return null;
            }

            var line = Encoding.UTF8.GetString(buffer, 0, end < 0 ? read : end).TrimStart('﻿').TrimEnd('\r');
            return DroidSessionUsage.CwdFromSessionStart(line);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
